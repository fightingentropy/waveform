import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Link from "next/link";
import { Providers } from "@/components/Providers";
import { AuthButtons } from "@/components/AuthButtons";
import { PlayerBar } from "@/components/PlayerBar";
import LibrarySidebar from "@/components/LibrarySidebar";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Waveform",
  description: "Waveform — minimal music player",
  icons: {
    icon: "/waveform.svg",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getServerSession(authOptions);
  return (
    <html lang="en">
      <body suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen`}>
        <Providers>
          <header className="relative z-50 border-b border-black/10 dark:border-white/10">
            <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
              <Link href="/" className="font-semibold inline-flex items-center gap-2">
                <img src="/waveform.svg" alt="Waveform" className="h-6 w-6" />
                <span>Waveform</span>
              </Link>
              <nav className="flex items-center gap-6">
                <Link href="/" className="opacity-80 hover:opacity-100">Home</Link>
                {session && (
                  <Link href="/upload" className="opacity-80 hover:opacity-100">Upload</Link>
                )}
                <AuthButtons />
              </nav>
            </div>
          </header>
          <LibrarySidebar />
          <main className={session ? "lg:pl-64" : ""}>{children}</main>
          <PlayerBar />
        </Providers>
      </body>
    </html>
  );
}
