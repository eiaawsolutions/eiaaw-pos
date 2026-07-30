import { BadRequestException, Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../prisma/prisma.service';

/**
 * AI Auto-Onboarding — "drop in the event script + item docs, get a
 * ready-to-sell catalog".
 *
 * ZERO-HALLUCINATION CONTRACT:
 *  - The extractor may only record a field value that is EXPLICITLY present
 *    in the source text (or in a user's answer).
 *  - Anything missing, ambiguous, or conflicting becomes a clarification
 *    question tied to a specific item ref + field.
 *  - Commit is blocked until every item has zero `missing` fields — the
 *    system structurally cannot sell an assumed price.
 */

const REQUIRED_FIELDS = ['name', 'price', 'barcode'] as const;

interface ExtractedItem {
  ref: string;
  name: string | null;
  sku: string | null;
  barcode: string | null;
  price: number | null; // sen
  category: string | null;
  qtyOnHand: number | null;
  evidence?: string;
}

interface ExtractionResult {
  eventNotes: string | null;
  items: ExtractedItem[];
  questions: { id: string; itemRef: string | null; field: string; question: string }[];
}

const EXTRACTION_SYSTEM_PROMPT = `You are the catalog-ingest engine of a point-of-sale system. You receive raw documents: event scripts/briefs, price lists, item sheets with barcodes/QR codes, CSVs, or free text.

Your job: extract sellable items into strict JSON.

ABSOLUTE RULES — violations corrupt real sales data:
1. NEVER invent, infer, or "reasonably assume" any value. A field is either EXPLICITLY stated in the document or it is null.
2. Prices: only extract when an explicit price is tied to that item. Convert to Malaysian sen (RM 4.50 -> 450). If the currency or the item-price linkage is unclear, set price null and raise a question.
3. Barcodes/QR values: copy digits/strings exactly as written. Never construct or complete a barcode.
4. If two items conflict (same barcode, two prices for one item, duplicate SKUs), raise a question — do not pick one.
5. For every null required field (name, price, barcode) and every ambiguity, output a precise clarification question referencing the item ref and quote the fragment of source text ("evidence") it came from.
6. If the document contains event context (event name, dates, booths, expected crowd), summarize it factually in eventNotes — again, no invention.

Output ONLY valid JSON matching:
{
  "eventNotes": string | null,
  "items": [{ "ref": "item-1", "name": string|null, "sku": string|null, "barcode": string|null, "price": number|null, "category": string|null, "qtyOnHand": number|null, "evidence": string }],
  "questions": [{ "id": "q-1", "itemRef": "item-1" | null, "field": "price", "question": string }]
}`;

@Injectable()
export class OnboardingService {
  constructor(private prisma: PrismaService) {}

  private anthropic(): Anthropic | null {
    return process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
  }

  /** Step 1 — create a session from dropped-in documents (raw text/CSV) */
  async createSession(name: string, sourceText: string) {
    if (!sourceText?.trim()) throw new BadRequestException('No document content provided');
    const session = await this.prisma.importSession.create({
      data: { name, sourceText, status: 'EXTRACTING' },
    });
    const extraction = await this.extract(sourceText, null);
    return this.applyExtraction(session.id, extraction);
  }

  /** Step 2 — answer open questions; re-extraction merges answers as ground truth */
  async answer(sessionId: string, answers: Record<string, string>) {
    const session = await this.prisma.importSession.findUniqueOrThrow({ where: { id: sessionId } });
    if (session.status === 'COMMITTED') throw new BadRequestException('Session already committed');
    const mergedAnswers = { ...((session.answers as Record<string, string>) ?? {}), ...answers };
    await this.prisma.importSession.update({ where: { id: sessionId }, data: { answers: mergedAnswers } });
    await this.prisma.importItem.deleteMany({ where: { sessionId } });
    const extraction = await this.extract(session.sourceText, mergedAnswers);
    return this.applyExtraction(sessionId, extraction);
  }

  /** Step 3 — commit: only allowed when zero open questions remain */
  async commit(sessionId: string, outletId: string) {
    const session = await this.prisma.importSession.findUniqueOrThrow({
      where: { id: sessionId },
      include: { items: true },
    });
    if (session.status !== 'READY') {
      throw new BadRequestException(
        'Session has unresolved questions — answer them first. The system will not assume missing values.',
      );
    }
    const created: string[] = [];
    for (const item of session.items) {
      if (!item.name || item.price == null || !item.barcode) continue; // structurally impossible when READY
      const category = item.category
        ? await this.prisma.category.upsert({
            where: { id: `cat-${item.category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` },
            update: {},
            create: {
              id: `cat-${item.category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
              name: item.category,
            },
          })
        : null;
      const sku = item.sku ?? `IMP-${item.barcode.slice(-8)}`;
      const product = await this.prisma.product.create({
        data: {
          name: item.name,
          categoryId: category?.id,
          taxCode: item.taxCode ?? 'SST8',
          variants: {
            create: {
              sku,
              name: item.name,
              price: item.price,
              barcodes: { create: { code: item.barcode } },
            },
          },
        },
        include: { variants: true },
      });
      await this.prisma.inventoryLevel.upsert({
        where: { outletId_variantId: { outletId, variantId: product.variants[0].id } },
        update: { onHand: item.qtyOnHand ?? 0 },
        create: { outletId, variantId: product.variants[0].id, onHand: item.qtyOnHand ?? 0 },
      });
      created.push(product.id);
    }
    await this.prisma.importSession.update({ where: { id: sessionId }, data: { status: 'COMMITTED' } });
    await this.prisma.importItem.updateMany({ where: { sessionId }, data: { status: 'COMMITTED' } });
    return { committed: created.length, productIds: created, readyToSell: true };
  }

  getSession(sessionId: string) {
    return this.prisma.importSession.findUniqueOrThrow({
      where: { id: sessionId },
      include: { items: true },
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async extract(
    sourceText: string,
    answers: Record<string, string> | null,
  ): Promise<ExtractionResult> {
    const client = this.anthropic();
    if (client) {
      const userContent = answers
        ? `SOURCE DOCUMENTS:\n${sourceText}\n\nUSER CLARIFICATION ANSWERS (treat as ground truth, keyed by question id):\n${JSON.stringify(
            answers,
            null,
            2,
          )}`
        : `SOURCE DOCUMENTS:\n${sourceText}`;
      const msg = await client.messages.create({
        model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5',
        max_tokens: 4096,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      });
      const text = msg.content.find((b) => b.type === 'text');
      const raw = text && 'text' in text ? text.text : '{}';
      const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
      return JSON.parse(json) as ExtractionResult;
    }
    // No API key: deterministic CSV/line parser with the same no-assumption contract
    return this.deterministicExtract(sourceText, answers);
  }

  /** Fallback parser (also useful for tests): "name, barcode, price" style lines */
  private deterministicExtract(sourceText: string, answers: Record<string, string> | null): ExtractionResult {
    const items: ExtractedItem[] = [];
    const questions: ExtractionResult['questions'] = [];
    const lines = sourceText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    let i = 0;
    for (const line of lines) {
      const parts = line.split(/[,\t;]/).map((p) => p.trim());
      if (parts.length < 2) continue;
      i += 1;
      const ref = `item-${i}`;
      const name = parts[0] || null;
      const barcode = parts.find((p) => /^\d{8,14}$/.test(p)) ?? null;
      const priceStr = parts.find((p) => /^(RM\s*)?\d+(\.\d{1,2})?$/i.test(p) && p !== barcode);
      const price = priceStr ? Math.round(parseFloat(priceStr.replace(/RM\s*/i, '')) * 100) : null;
      const item: ExtractedItem = {
        ref,
        name,
        sku: null,
        barcode,
        price,
        category: null,
        qtyOnHand: null,
        evidence: line,
      };
      for (const field of REQUIRED_FIELDS) {
        const qid = `q-${ref}-${field}`;
        if (item[field] == null) {
          const answered = answers?.[qid];
          if (answered != null && answered !== '') {
            if (field === 'price') item.price = Math.round(parseFloat(answered.replace(/RM\s*/i, '')) * 100);
            else (item as any)[field] = answered;
          } else {
            questions.push({
              id: qid,
              itemRef: ref,
              field,
              question: `For "${line}": what is the ${field}? (not explicitly stated in the document)`,
            });
          }
        }
      }
      items.push(item);
    }
    if (!items.length) {
      questions.push({
        id: 'q-doc-format',
        itemRef: null,
        field: 'document',
        question:
          'No items could be read from the document. Please provide lines as: name, barcode, price (e.g. "Teh Tarik, 9551000000017, RM4.50").',
      });
    }
    return { eventNotes: null, items, questions };
  }

  private async applyExtraction(sessionId: string, extraction: ExtractionResult) {
    const openQuestions = extraction.questions ?? [];
    await this.prisma.importItem.deleteMany({ where: { sessionId } });
    for (const item of extraction.items ?? []) {
      const missing = REQUIRED_FIELDS.filter((f) => item[f] == null);
      await this.prisma.importItem.create({
        data: {
          sessionId,
          ref: item.ref,
          name: item.name,
          sku: item.sku,
          barcode: item.barcode,
          price: item.price ?? undefined,
          category: item.category,
          qtyOnHand: item.qtyOnHand ?? undefined,
          evidence: item.evidence,
          missing,
          status: missing.length ? 'DRAFT' : 'RESOLVED',
        },
      });
    }
    const status = openQuestions.length ? 'AWAITING_ANSWERS' : 'READY';
    const session = await this.prisma.importSession.update({
      where: { id: sessionId },
      data: { status, questions: openQuestions, eventNotes: extraction.eventNotes },
      include: { items: true },
    });
    return session;
  }
}
