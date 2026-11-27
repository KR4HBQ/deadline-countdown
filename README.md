# Deadline Countdown

A small self-hosted site that shows **calendar days** and **business days** until a list of dates. Business days skip weekends and your company holidays.

- **Main page** (`/`): read-only countdown cards. Anyone can view it.
- **Admin page** (`/admin.html`): behind a password. Add and remove countdowns, edit holidays and counting rules, set the page title, and upload your own logo, with a live preview. Click **Save** and the main page updates.

The logo appears beside the page title and as the browser tab icon. You can upload a PNG, JPG, GIF, WebP or SVG. Large images are shrunk to 256 pixels and stored inside `config.js`, so there's no separate file to manage. **Use the default icon** switches back.

It's plain HTML, CSS and JavaScript, plus one small Node.js server file with **no dependencies**.

## How the pieces fit

```
browser ──https──▶ your nginx ──http──▶ deadline-countdown container (port 8080)
                   (hostname, SSL)       (serves the pages, checks the admin
                                          password, saves config.js to /data)
```

The **container** runs the site: it serves the pages and saves your changes. Your **existing nginx** doesn't hold any of the files. It only gives the site a hostname and https, and passes each request on to the container (a "reverse proxy"). nginx is optional: without it you open `http://<server>:8080/` directly.

nginx can't save changes on its own, which is why the container exists. If you only want to *show* countdowns and are happy to edit `config.js` by hand, you can skip the container and let nginx serve the `public/` folder as plain files (see "As plain static files" below).

## Running it

### Docker (recommended)

```sh
git clone <this repo> deadline-countdown
cd deadline-countdown
# edit docker-compose.yml: set ADMIN_PASSWORD
docker compose up -d --build
```

Open `http://<host>:8080/`. Your settings are stored in `./data/config.js` and survive updates. To update, `git pull` and run `docker compose up -d --build` again.

| Variable | Default | What it does |
|---|---|---|
| `ADMIN_PASSWORD` | *(none)* | Admin password. **Without it the admin page is read-only.** |
| `TRUST_PROXY` | off | Set to `1` behind nginx or another reverse proxy, so client IPs and https are detected correctly |
| `SESSION_HOURS` | `12` | How long an admin sign-in lasts |
| `PORT` | `8080` | Port inside the container |
| `DATA_DIR` | `/data` | Where `config.js` is kept. Mount it as a volume. |

### Unraid

The image isn't published to a registry yet, so build it on the server.

**With the Docker Compose Manager plugin:** add a new stack and paste in `docker-compose.yml`. Point `build:` at the folder you cloned to, set `ADMIN_PASSWORD`, change the volume to `/mnt/user/appdata/deadline-countdown:/data`, and uncomment `user: "99:100"` so the appdata folder stays writable.

**Without the plugin**, from the Unraid terminal:

```sh
cd /mnt/user/appdata && git clone <this repo> deadline-countdown-src
cd deadline-countdown-src && docker build -t deadline-countdown .
docker run -d --name deadline-countdown --restart unless-stopped \
  --user 99:100 -p 8080:8080 \
  -e ADMIN_PASSWORD='your-password' -e TRUST_PROXY=1 \
  -v /mnt/user/appdata/deadline-countdown:/data \
  deadline-countdown
```

### Behind nginx

At its own hostname:

```nginx
server {
    listen 443 ssl;
    server_name countdown.example.com;
    # ssl_certificate ... (as for your other sites)

    location / {
        proxy_pass http://UNRAID_IP:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
}
```

Or under a path on an existing site. All links are relative, so this works without changes:

```nginx
location /countdown/ {
    proxy_pass http://UNRAID_IP:8080/;   # trailing slash strips /countdown
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
}
```

Set `TRUST_PROXY=1` on the container when it sits behind nginx. Serve it over https so the admin password isn't sent in the clear. If you use SWAG or Nginx Proxy Manager, the same `proxy_pass` settings apply.

### Without Docker

With Node.js 18 or newer:

```sh
ADMIN_PASSWORD='your-password' node server.js
```

It listens on port 8080 and stores settings in `./data/`.

### As plain static files (no server)

Copy the `public/` folder to any static web host, or open `public/index.html` straight from disk. The main page works the same. Since there's no server to save to, the admin page then works differently:
- On first visit it asks you to choose a password. That password is stored as a hash in `config.js`, and it only keeps casual visitors out, since anyone can read static files.
- Instead of **Save**, it offers **Download config.js**. You replace `public/config.js` with the downloaded file by hand.

## Files

| Path | What it is |
|---|---|
| `server.js` | The server: serves `public/`, handles admin sign-in and saving |
| `public/index.html` | Main page |
| `public/admin.html` | Admin page (works in both server and static mode) |
| `public/app.js` | Counting logic and card rendering, shared by both pages |
| `public/style.css` | Styles, shared by both pages |
| `public/config.js` | Example settings. The server copies this into `DATA_DIR` on first start. |
| `public/favicon.svg` | The icon. The PNGs and `site.webmanifest` are versions of it for phones and "install as app". |
| `Dockerfile`, `docker-compose.yml` | Container setup |

## How the counting works

- **Calendar days**: the target date minus today.
- **Business days**: every day from tomorrow through the target date, skipping non-working days and holidays. Admin settings let you count today, or leave out the target date.
- Countdowns are shown soonest first. Past ones move to the end and count up ("12 days ago").
- Dates are counted in whole days in the viewer's local calendar, so daylight-saving changes never shift a count.

Holidays are entered one per line, as `2026-12-25 Christmas` or `12/25/2026, Christmas`. Lines starting with `#` are ignored, and you can paste a column from a spreadsheet.

## Security notes

- In server mode the password is checked on the server, sign-ins use an HttpOnly, SameSite=Strict cookie, and saving requires a signed-in session. Five wrong passwords lock that IP out for a growing interval.
- Saves are only accepted from the site's own pages (JSON with a matching `Origin`), and the server keeps only known fields with valid values before writing.
- The previous `config.js` is kept as `config.js.bak` in the data folder after each save.
- The server serves a fixed list of files and nothing else from disk.

## External requests

The only one is the IBM Plex font from Google Fonts. Without it, the pages fall back to your system font. To avoid it, delete the `fonts.googleapis.com` `<link>` from both HTML files.
