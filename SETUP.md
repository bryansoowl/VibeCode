# InboxMY — OAuth Credentials Setup Guide

This guide is for whoever is **running the InboxMY server** (that's you). You register the app with Google and Microsoft once. Your own users never touch credentials — they just click "Connect Gmail" or "Connect Outlook" in the dashboard and go through Google/Microsoft's standard permission screen.

Run `npm run setup` in the `inboxmy-backend/` directory. It walks you through every step and writes `.env` automatically. This guide is the full reference if you want to understand what you're doing.

---

## Section 1 — Google Cloud Setup (Gmail)

### Step 1: Create a Google Cloud project

1. Go to [https://console.cloud.google.com](https://console.cloud.google.com) and sign in with your Google account.
2. Click the project selector at the top of the page (it may say "Select a project" or show a project name).
3. Click **New Project**.
4. Give it a name — `InboxMY` works fine.
5. Click **Create** and wait a few seconds for it to be ready.
6. Make sure the new project is selected in the top bar before continuing.

### Step 2: Enable the Gmail API

1. In the left sidebar, click **APIs & Services → Library**.
2. Search for `Gmail API`.
3. Click on **Gmail API** in the results.
4. Click **Enable**. Wait for it to activate.

### Step 3: Configure the OAuth consent screen

Before you can create credentials, Google requires you to fill in a consent screen — this is what your users see when they authorise the app.

1. Go to **APIs & Services → OAuth consent screen**.
2. Under **User Type**, select **External** and click **Create**.
   - If you only see "Internal", your account is a Workspace account — select Internal, it will still work for personal use.
3. Fill in the required fields:
   - **App name**: InboxMY
   - **User support email**: your email address
   - **Developer contact information**: your email address
4. Click **Save and Continue** through the Scopes and Test Users pages (you'll add a test user in Step 5).
5. On the Summary page, click **Back to Dashboard**.

### Step 4: Create OAuth 2.0 credentials

1. Go to **APIs & Services → Credentials**.
2. Click **+ Create Credentials → OAuth 2.0 Client ID**.
3. Under **Application type**, select **Web application**.
4. Give it a name — `InboxMY local` works.
5. Under **Authorised redirect URIs**, click **+ Add URI** and enter:
   ```
   http://localhost:3001/auth/gmail/callback
   ```
6. Click **Create**.
7. A dialog appears with your **Client ID** and **Client Secret**. Copy both — you will paste them into `npm run setup`.

### Step 5: Add your email as a test user

Because your OAuth app is in "Testing" mode, only explicitly added email addresses can authorise it.

1. Go to **APIs & Services → OAuth consent screen**.
2. Scroll to the **Test users** section.
3. Click **+ Add Users**.
4. Enter the Gmail address you want to connect to InboxMY.
5. Click **Add**.

> Your app stays in Testing mode indefinitely for personal local use. You do not need to go through Google's full verification process.

### Step 6: Copy credentials into .env

Run `npm run setup` from `inboxmy-backend/` and paste your Client ID and Client Secret when prompted.

### Troubleshooting

**Error 403: org_internal**
Your OAuth app is set to Internal. Go to **APIs & Services → OAuth consent screen** and click **Make External**.

**Error: insufficient authentication scopes**
The Gmail API may not be enabled. Go to **APIs & Services → Library**, search Gmail API, and verify it shows "API Enabled".

**Error: Gmail API has not been used in project**
The Gmail API was just enabled — wait 1–2 minutes and try again.

---

## Section 2 — Azure Portal Setup (Outlook)

### Step 1: Sign in to Azure Portal

1. Go to [https://portal.azure.com](https://portal.azure.com) and sign in with a Microsoft account (any account — personal Outlook/Hotmail or a work/school account).
2. If you see "Welcome to Microsoft Azure" — you're in the right place.

### Step 2: Register a new application

1. In the search bar at the top, type `App registrations` and click on it.
2. Click **+ New registration**.
3. Fill in the form:
   - **Name**: InboxMY
   - **Supported account types**: Select **"Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)"**
     > This option lets you connect both personal Outlook/Hotmail accounts and work/school accounts. If you only need personal accounts, you can select the personal-only option — but the broader option is safer.
   - **Redirect URI**: leave blank for now (you'll add it in the next step)
4. Click **Register**.
5. You are taken to the app's Overview page. **Copy the Application (client) ID** — this is your `MICROSOFT_CLIENT_ID`.

### Step 3: Configure redirect URI

1. In the left sidebar of your app registration, click **Authentication**.
2. Under **Platform configurations**, click **+ Add a platform**.
3. Select **Web**.
4. In the **Redirect URIs** field, enter:
   ```
   http://localhost:3001/auth/outlook/callback
   ```
5. Click **Configure**.
6. Scroll down and under **Advanced settings**, ensure **Allow public client flows** is set to **No**.
7. Click **Save**.

### Step 4: Add API permissions

1. In the left sidebar, click **API permissions**.
2. Click **+ Add a permission**.
3. Select **Microsoft Graph**.
4. Select **Delegated permissions**.
5. Search for and check **Mail.Read**.
6. Search for and check **User.Read**.
7. Click **Add permissions**.
8. Click **Grant admin consent for [your directory]** and confirm.
   > If you don't see the Grant button, you may not have admin rights. For personal Microsoft accounts this step is usually automatic.

### Step 5: Generate a client secret

1. In the left sidebar, click **Certificates & secrets**.
2. Click **+ New client secret**.
3. Give it a description — `InboxMY local` works.
4. Set expiry — **24 months** is the longest option.
5. Click **Add**.
6. **Copy the Value immediately** (not the Secret ID). It is only shown once. This is your `MICROSOFT_CLIENT_SECRET`.

> If you lose the secret value, you must delete it and generate a new one — you cannot retrieve it later.

### Step 6: Copy credentials into .env

Run `npm run setup` from `inboxmy-backend/` and paste your Client ID and Client Secret when prompted.

### Troubleshooting

**AADSTS50011: The redirect URI does not match**
Check that the redirect URI in Azure exactly matches `http://localhost:3001/auth/outlook/callback` with no trailing slash.

**AADSTS70011: The provided value for the input parameter 'scope' is not valid**
The Mail.Read and/or User.Read permissions may not be granted. Return to API permissions and click Grant admin consent.

**Client secret is showing as expired**
Azure secrets expire. Generate a new secret in Certificates & secrets, copy the new Value, and re-run `npm run setup`.

---

## Section 3 — Verifying Setup

1. Run `npm run setup` from `inboxmy-backend/` and complete all prompts.
2. Run `npm run build && npm start`.
3. Check the terminal — you should see:
   ```
   ────────────────────────────────────────────
     InboxMY Config
   ────────────────────────────────────────────
     [✓] Gmail (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
     [✓] Outlook (MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET)
   ────────────────────────────────────────────
   ```
4. Open `http://localhost:3001` in your browser.
5. Click **Connect Gmail** or **Connect Outlook** in the accounts sidebar.
6. You are redirected to Google/Microsoft's permission screen — approve access.
7. The account appears in the dashboard. Click **↻ Sync** to fetch your emails.

---

## AI Notifications (Optional)

InboxMY can generate smart notification copy using Gemini 2.0 Flash. This is optional — the app works without it using plain copy.

### Getting a Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey) and create an API key
2. Free tier: ~15 requests/minute — more than enough for InboxMY's 60-minute scheduler
3. Cost: effectively free at personal usage scale

### Configuring the Key

1. Launch InboxMY (Electron app)
2. Click the settings gear icon
3. Under **AI Notifications**, paste your Gemini API key and click **Save**
4. The key is encrypted with Windows DPAPI (`safeStorage`) and stored only on your device

### What AI Notifications Do

- **Smart filtering**: Suppresses low-value alerts (Shopee promotions, small amounts)
- **Rich copy**: Generates contextual messages ("TNB eBill due Friday — RM142.80")
- **Fallback**: If Gemini fails (network, quota), plain copy is used automatically

### Privacy Note

Your Gemini API key is:
- Never sent to InboxMY servers (there are none)
- Never logged
- Encrypted with Windows DPAPI on your device
- Passed directly from your device to Google's API
