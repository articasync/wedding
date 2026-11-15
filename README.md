# Mariam & Chris — wedding site

A static site (no build step) in the "Atelier" design.

| File | What it is |
| --- | --- |
| `index.html` | The whole guest site: drag-to-unlock gate, Welcome, Our Story, RSVP, Schedule, Q&A, Gallery |
| `admin.html` | Guest desk at `/admin`: replies, CSV download, email and text blasts |
| `config.js` | One setting: the address of your Google Sheet backend |
| `google-apps-script/Code.gs` | The backend. It is pasted into Google Sheets, not deployed to Vercel |
| `images/` | Put your photos here |

## 1. Put it online (Vercel)

Push these files to the root of the GitHub repo that Vercel deploys. There is nothing to configure: no framework, no build command.

## 2. Connect RSVPs to Google Sheets (free)

1. Create a new Google Sheet, for example "Wedding RSVPs".
2. In the sheet: **Extensions → Apps Script**. Delete the sample code, paste in all of `google-apps-script/Code.gs`, and save.
3. Choose the function **setup** in the toolbar and press **Run**. Approve the permissions Google asks for. This creates three tabs: `RSVPs`, `Guests`, `Blast log`.
4. **Project Settings (gear icon) → Script properties → Add**: `ADMIN_PASSWORD` with a password of 8+ characters. This is the admin dashboard password.
5. **Deploy → New deployment → Web app**. Execute as: **Me**. Who has access: **Anyone**. Deploy and copy the **Web app URL**.
6. Paste that URL into `config.js` as `BACKEND_URL`, then commit and push.

After that, each reply on the RSVP page becomes a row in the `RSVPs` tab (name, email, mobile, address, yes/no, party size, note). A guest who replies again with the same email updates their row.

If you edit `Code.gs` later, use **Deploy → Manage deployments → Edit → New version** so the URL stays the same.

## 3. Guest list for blasts

Paste your invite list into the `Guests` tab (Name, Email, Phone). The admin page uses it for "Everyone" and "Yet to reply".

## 4. Blasts

- **Email** is sent from the Google account that owns the sheet. A personal Gmail account can send to 100 recipients a day through Apps Script; the admin page shows how many are left.
- **Texts** need a Twilio account (paid per message). Add `TWILIO_SID`, `TWILIO_TOKEN` and `TWILIO_FROM` (your Twilio number, like `+15551234567`) to Script properties. Without them the Text option explains that it is not set up.
- Write `{name}` in a message to greet each guest by first name. Use "Test: just me" first.

## Editing content

Open `index.html` and find the block marked `CONTENT`. Story chapters, schedule, Q&A and gallery are plain lists there.

Photos: add files to `images/` and set, for example, `img: 'images/paris.jpg'` on a story chapter, or `{ src: 'images/us-01.jpg', alt: 'Us in Central Park' }` in `GALLERY`.

## Notes

- The gate remembers that a visitor has unlocked it until they close the tab. "Lock the door again" in the footer resets it.
- Both pages ask search engines not to index them.
