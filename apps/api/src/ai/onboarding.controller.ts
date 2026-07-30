import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { OnboardingService } from './onboarding.service';
import { AuthGuard, Roles } from '../common/auth.guard';

@Controller('ai/onboarding')
@UseGuards(AuthGuard)
@Roles('OWNER', 'MANAGER')
export class OnboardingController {
  constructor(private onboarding: OnboardingService) {}

  /** Drop in the event script + item documents (raw text / CSV content) */
  @Post('sessions')
  create(@Body() body: { name: string; sourceText: string }) {
    return this.onboarding.createSession(body.name ?? 'Import', body.sourceText);
  }

  @Get('sessions/:id')
  get(@Param('id') id: string) {
    return this.onboarding.getSession(id);
  }

  /** Answer the system's clarification questions (keyed by question id) */
  @Post('sessions/:id/answers')
  answer(@Param('id') id: string, @Body() body: { answers: Record<string, string> }) {
    return this.onboarding.answer(id, body.answers ?? {});
  }

  /** Commit to live catalog — blocked until zero questions remain */
  @Post('sessions/:id/commit')
  commit(@Param('id') id: string, @Body() body: { outletId: string }) {
    return this.onboarding.commit(id, body.outletId);
  }
}
