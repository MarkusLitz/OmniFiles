# Privacy Policy for OmniFiles

**Last updated:** August 4, 2026

This Privacy Policy describes how the OmniFiles ChromeOS extension handles your data.

## 1. Data Collection and Usage
OmniFiles operates entirely locally on your ChromeOS device. We **do not** collect, transmit, store, or sell any of your personal information, files, or telemetry data to any third-party servers or our own servers. 

## 2. Authentication Data
To function as a file system provider, OmniFiles requires authentication credentials (such as OAuth tokens, API keys, or passwords) to connect to your chosen cloud storage providers (e.g., Google Drive, OneDrive, Amazon S3).
*   **Local Storage:** All authentication data is stored locally on your device within the Chrome extension's secure local storage (`chrome.storage.local`).
*   **Direct Communication:** When communicating with cloud providers, OmniFiles sends your authentication data directly to the respective provider's official API. It never passes through any intermediary servers.

## 3. User Files and Metadata
OmniFiles acts as a bridge between your cloud storage and the ChromeOS Files app. 
*   File contents and metadata (such as file names, sizes, and thumbnails) are processed locally on your device.
*   To improve performance, metadata and generated image thumbnails are cached locally on your device using IndexedDB. This cache can be cleared at any time via the extension's context menu.

## 4. Changes to this Policy
If we make significant changes to this privacy policy, we will update the "Last updated" date at the top of this document.

## 5. Contact
If you have any questions about this Privacy Policy, please open an issue on our GitHub repository.
