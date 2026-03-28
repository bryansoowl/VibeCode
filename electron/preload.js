// electron/preload.js
// Exposes a safe, typed bridge from the main process to the renderer via contextBridge.
// contextIsolation: true — renderer cannot access Node.js or Electron directly.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('inboxmy', {
  // Manually trigger a Windows toast from the renderer
  notify: (title, body) =>
    ipcRenderer.invoke('fire-notification', { title, body }),

  // Receive live bill alert data from the scheduler
  onBillAlert: (cb) =>
    ipcRenderer.on('bill-alert', (_, data) => cb(data)),

  // Deep link: navigate to a specific bill after toast click
  onNavigateToBill: (cb) =>
    ipcRenderer.on('navigate-to-bill', (_, billId) => cb(billId)),

  // Background sync completed — renderer should refresh email list
  onSyncComplete: (cb) =>
    ipcRenderer.on('sync-complete', () => cb()),

  // Gemini API key — stored encrypted via safeStorage (Windows DPAPI)
  saveGeminiKey: (key) =>
    ipcRenderer.invoke('save-gemini-key', key),

  getGeminiKey: () =>
    ipcRenderer.invoke('get-gemini-key'),

  // Auto-launch at Windows startup toggle
  setAutoLaunch: (enabled) =>
    ipcRenderer.invoke('set-auto-launch', enabled),
  getAutoLaunch: () =>
    ipcRenderer.invoke('get-auto-launch'),

  // Email arrival — carries authoritative unreadCount from main process
  onNewEmails: (cb) => ipcRenderer.on('new-emails', (_, data) => cb(data)),

  // Notification preference toggle
  getNotifPref: () => ipcRenderer.invoke('get-notif-pref'),
  setNotifPref: (enabled) => ipcRenderer.invoke('set-notif-pref', enabled),
})
