# Trancy

YouTube subtitle learning player for iPhone Safari.

## Local Run

```powershell
npm start
```

Open `http://localhost:3000`.

## Public Deploy

This project is prepared for Render.

### Option A: Render Blueprint

1. Push this folder to GitHub.
2. In Render, create a new Blueprint and connect the repo.
3. Render will read `render.yaml`, run `npm install`, and start the app with `npm start`.

### Option B: Standard Node Web Service

Use these settings:

- Build Command: `npm install`
- Start Command: `npm start`
- Environment: `HOST=0.0.0.0`

## iPhone Home Screen

After the app is deployed:

1. Open the deployed URL in Safari on iPhone.
2. Tap Share.
3. Tap `Add to Home Screen`.
4. Launch it from the home screen for standalone app-like mode.

## Added for Deployment

- `render.yaml`: Render deployment config
- `manifest.webmanifest`: install metadata
- `sw.js`: basic app shell caching
- `icons/`: home screen and manifest icons

## API

- `/api/search?q=keyword`
- `/api/recommendations?videoId=...`
- `/api/transcript?videoId=...&lang=ja`
- `/api/dictionary?word=...`
