# QUANTUM - Pinuy Binuy Investment Analyzer

Full-stack investment analysis platform for Israeli urban renewal (Pinuy Binuy) projects.

## Features
- 129+ tracked complexes across Israel
- IAI (Investment Attractiveness Index) scoring
- SSI (Seller Stress Index) for distressed sellers
- nadlan.gov.il transaction scraping
- yad2 listing tracking with price change detection
- mavat planning authority status monitoring
- Benchmark service for actual premium calculation
- Perplexity AI-powered data enrichment
- Weekly automated 9-step scan pipeline
- Email notifications (Trello cards + office digest)

## API Endpoints
See `GET /` for full endpoint list.

## Weekly Scan Pipeline
1. nadlan.gov.il transaction scan
2. Benchmark calculation
3. mavat planning status + committee tracking
4. Perplexity AI scan
5. yad2 listing scan
6. SSI score calculation
7. IAI score recalculation
8. Alert generation
9. Email notifications

## Environment Variables
- `DATABASE_URL` - PostgreSQL connection string
- `PERPLEXITY_API_KEY` - Perplexity API key
- `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` - Email notifications
- `SCAN_CRON` - Weekly scan schedule (default: `0 4 * * 0`)
