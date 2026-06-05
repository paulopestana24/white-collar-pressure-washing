# White Collar Pressure Washing

Marketing website for **White Collar Pressure Washing**.

Single-page, mobile-first static site (no build step).

## Tech
- One `index.html` with [Tailwind CSS](https://tailwindcss.com) via CDN (inline config) and Google Fonts.
- Brand assets in `Brand assets/` (logo), job photos in `Before and After work/`, plus `Van photo.jfif`.

## Local preview
```bash
node serve.mjs        # serves the folder at http://localhost:3000
```
Optional screenshots (headless Chrome): `node screenshot.mjs http://localhost:3000 [label] [--mobile] [--at=#section]`

## Deploy (Vercel)
This is a fully static site, so **no build is required**:
1. In Vercel, **Add New → Project → Import** this GitHub repo.
2. Framework preset: **Other**. Build command: *(none)*. Output directory: `./` (root).
3. Deploy, then add your custom domain under **Project → Settings → Domains** and point your DNS as Vercel instructs.

Every push to `main` then auto-deploys.

## Notes
- Source assets are `.jfif`; convert to `.jpg`/`.webp` before launch for broadest browser support.
