# 🎨 Meshy Downloader

<div align="center">

[![GitHub stars](https://img.shields.io/github/stars/Pouare514/meshy-downloader?style=for-the-badge&color=7c3aed&logo=github)](https://github.com/Pouare514/meshy-downloader/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-7c3aed?style=for-the-badge)](https://github.com/Pouare514/meshy-downloader/blob/main/LICENSE)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-informational?style=for-the-badge&logo=google-chrome&color=7c3aed)](https://chrome.google.com/webstore)

**The ultimate companion for Meshy.ai creators. Download your 3D models and textures with a single click.**

[Features](#-key-features) • [Installation](#-installation) • [How it Works](#%EF%B8%8F-how-it-works) • [Security](#-security--privacy)

</div>

---

## ✨ Key Features

Meshy Downloader bridges the gap between the web-based AI creation tool and your local creative workflow.

*   🚀 **Automatic Auth Detection** — No API keys needed. Just be logged into Meshy.ai.
*   📦 **One-Click Model Export** — Download `.glb` files directly to your machine.
*   🖼️ **Batch Texture Download** — Grab all generated textures (Base, Normal, Roughness) in one go.
*   🔍 **Rich Metadata** — View polygon counts (faces/vertices) and creation dates at a glance.
*   🎨 **Visual Gallery** — High-quality thumbnails for every model in your library.
*   📁 **Smart Organization** — Files are automatically organized in a `Downloads/meshy_models/` folder.
*   ⚡ **Ultra Lightweight** — Zero dependencies, built with high-performance Vanilla JS.

## 📦 Installation

### Developer Mode (Current Method)

1.  **Clone the Repository**
    ```bash
    git clone https://github.com/Pouare514/meshy-downloader.git
    cd meshy-downloader
    ```
2.  **Open Extensions Page**
    Navigate to `chrome://extensions/` in your Chrome browser.
3.  **Enable Developer Mode**
    Toggle the switch in the top-right corner.
4.  **Load the Extension**
    Click **"Load unpacked"** and select the `meshy-downloader` folder from this repo.

---

## 🔧 Usage

1.  **Login** to your account at [Meshy.ai](https://meshy.ai).
2.  **Click** the Meshy Downloader icon in your browser toolbar.
3.  **Hit "Fetch Models"** — the extension will automatically extract your session token.
4.  **Explore and Download**:
    *   Click **Download GLB** for the 3D model.
    *   Click **Download Textures** to save all associated maps.

> [!TIP]
> If a model has a short prompt, the extension will use it as the file name for better organization!

---

## 🛠️ How it Works

The extension uses a secure multi-layer approach to handle your data:

```mermaid
graph TD
    A[Meshy.ai Dashboard] -->|Supabase Cookie| B(Content Script)
    B -->|Encrypted Token| C{Background Service}
    C -->|Authenticated API Call| D[Meshy V2 API]
    D -->|Task Data| E(Popup UI)
    E -->|User Click| F[Native Download Manager]
    F -->|Organized Storage| G[/Downloads/meshy_models/]
```

### Technical Stack
- **Manifest V3**: Compliant with the latest Chrome extension standards.
- **Chrome Storage API**: Holds the session token locally and removes it after an unauthorized API response.
- **Browser-side Decryption**: Uses Meshy's page worker credentials locally when available, then converts GLB geometry to OBJ or STL.

---

## 🔄 Conversion and export formats

Meshy.ai may deliver encrypted model data through its browser worker. The extension uses that worker from the active Meshy tab when the required authorization data has been observed.

### How it works:
1.  **Detection**: The extension identifies when Meshy's model data requires the browser worker.
2.  **Browser Bridge**: It communicates with Meshy's decryption worker directly within the active browser tab.
3.  **Local Processing**: The data is reconstructed as GLB, then optionally converted to OBJ or binary STL in the content script.
4.  **Automatic Export**: The result is triggered as a standard browser download for use in Blender, Unity, and Unreal Engine.

> [!NOTE]
> This process happens entirely in your browser. No data is decrypted on external servers, ensuring your 3D models remain private.

---

## 🔐 Security & Privacy

We take your data seriously.
*   ✅ **Local credential handling**: The extension stores the session token locally and sends requests only to Meshy API domains.
*   ✅ **No tracking service**: The extension does not send analytics or model data to a third-party service.
*   ✅ **Explicit activation**: Model retrieval starts when you use the popup.
*   ✅ **Transparent Code**: Being open-source, you can audit every line of code.

---

## 🐛 Troubleshooting

| Issue | Solution |
| :--- | :--- |
| **"Token not found"** | Refresh your Meshy.ai tab and wait 2 seconds before clicking "Fetch". |
| **Models not loading** | Ensure you have an active internet connection and are logged in. |
| **Download fails** | Check if Chrome has permission to download multiple files. |

---

## 🤝 Contributing

We love contributions! Whether it's a bug fix, a new feature, or a UI improvement.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

<div align="center">

**Made with ❤️ for the 3D Community**

[Report Bug](https://github.com/Pouare514/meshy-downloader/issues) • [Request Feature](https://github.com/Pouare514/meshy-downloader/issues)

</div>
