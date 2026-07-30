import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'EIAAW POS',
  description: 'EIAAW Solutions — AI-native Point of Sale',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
