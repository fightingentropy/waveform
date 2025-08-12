Spotify Clone built with Next.js 15 (App Router), Tailwind, Prisma (SQLite), and NextAuth.

### Quick start
- Install dependencies: `npm install`
- Environment: `.env` already contains `DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`
- Generate DB client and migrate: `npx prisma generate && npx prisma migrate dev --name init`
- Start dev server: `npm run dev`

### Features
- Email/password auth (NextAuth Credentials + Prisma adapter)
- Upload songs (cover + audio) to `public/uploads` with metadata in SQLite
- Home feed listing songs; click a card to play
- Global player bar with play/pause, seek, volume

### Key files
- `prisma/schema.prisma`: DB schema
- `src/auth.ts`: NextAuth config and handlers
- `src/app/api/auth/[...nextauth]/route.ts`: Auth route handlers
- `src/app/api/songs/route.ts`: Songs list + upload endpoint (multipart)
- `src/app/upload/page.tsx`: Upload UI
- `src/components/PlayerBar.tsx`: Audio player
- `src/store/player.ts`: Player state

### Notes
- Local uploads are for dev only; use object storage in production.
- To reset DB: delete `prisma/dev.db` and re-run migrations.
