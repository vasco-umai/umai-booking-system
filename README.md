# UMAI Booking System

Meeting scheduling system for UMAI. Handles staff availability, Google Calendar sync, and booking management.

## Stack

- **Backend:** Node.js 20 + Express 4
- **Database:** PostgreSQL 16
- **Calendar:** Google Calendar API (OAuth per-staff)
- **Email:** Nodemailer (SMTP)
- **Auth:** JWT + bcrypt

## Quick Start (Docker)

```bash
# 1. Copy env file and fill in values
cp .env.example .env

# 2. Start everything
docker-compose up -d

# 3. Run migrations
docker exec umai-booking node server/migrations/run.js

# 4. Seed default data
docker exec umai-booking node server/seeds/run.js
```

The app runs at `http://localhost:3001`.

## Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Copy and configure env
cp .env.example .env
# Edit .env with your PostgreSQL credentials, Google OAuth keys, etc.

# 3. Create database
createdb umai_booking

# 4. Run migrations
npm run migrate

# 5. Seed default data
npm run seed

# 6. Start server
npm run dev
```

## Environment Variables

See `.env.example` for all variables. The critical ones:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | Secret for signing auth tokens |
| `GOOGLE_OAUTH_CLIENT_ID` | Yes | Google Cloud OAuth client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Yes | Google Cloud OAuth client secret |
| `GOOGLE_OAUTH_REDIRECT_URI` | Yes | OAuth callback URL |
| `SMTP_HOST` | For emails | SMTP server for sending confirmations |

## Google Calendar Setup

1. Create a Google Cloud project
2. Enable the Google Calendar API
3. Create OAuth 2.0 credentials (Web application type)
4. Add your redirect URI: `https://your-domain.com/api/admin/staff/google/callback`
5. Set the client ID and secret in `.env`

Each staff member connects their own Google Calendar via OAuth in the admin panel.

## API Endpoints

### Public
- `GET /api/availability` - Get available time slots
- `POST /api/bookings` - Create a booking
- `GET /api/health` - Health check

### Auth
- `POST /api/auth/login` - Admin login
- `POST /api/auth/set-password` - Set/reset password
- `POST /api/auth/forgot-password` - Request password reset
- `POST /api/auth/check-email` - Check if email exists
- `GET /api/auth/invite/validate` - Validate invite token

### Admin (requires JWT)
- `GET/POST /api/admin/staff` - Staff management
- `GET/POST /api/admin/schedules` - Staff weekly schedules
- `GET/POST /api/admin/blocked-times` - Block off unavailable times
- `GET/POST /api/admin/meeting-types` - Meeting type definitions
- `GET /api/admin/bookings` - View/manage bookings
- `POST /api/admin/staff/:id/google/authorize` - Start Google OAuth flow
- `GET /api/admin/staff/google/callback` - OAuth callback

### Staff Invite
- `GET /api/invite` - Accept invite and set up account

## Frontend

Two HTML pages served from `/frontend`:
- `admin.html` - Admin dashboard (staff, schedules, bookings management)
- `invite.html` - Staff invite onboarding (password + Google Calendar setup)

## Database

11 migrations in `server/migrations/`. Key tables:
- `admin_users` - Staff login credentials and roles
- `staff_members` - Team members with Google Calendar tokens
- `schedules` - Per-staff weekly availability (timezone-aware)
- `blocked_times` - Blackout dates/times
- `bookings` - All meeting bookings
- `meeting_types` - Meeting type definitions (duration, cost)

## How It Works

1. Guest visits booking page and picks a meeting type
2. System checks staff availability (schedules + Google Calendar free/busy)
3. Available slots are shown
4. Guest books a slot
5. System assigns a staff member using weighted distribution algorithm
6. Google Calendar event is created on the assigned staff's calendar
7. Confirmation email is sent to the guest
