# Testing the ChromeOS Rclone Extension

This document describes how to test the current state of the extension on a Chromebook using the provided ZIP archive.

## Installation

1. Copy the `chromeos-rclone-extension-test.zip` file to your Chromebook.
2. Unzip the archive into a folder of your choice.
3. Open the Chrome browser and navigate to `chrome://extensions/`.
4. Enable **Developer mode** in the top right corner.
5. Click **Load unpacked** (top left) and select the `src` folder from the unzipped archive.
6. The "ChromeOS Rclone" extension should now be active.

## Testing Steps

### 1. Configuration
- Right-click the extension icon and select **Options**.
- Enter some placeholder text (a mock Rclone config block) into the text area.
- Click **Save**.

### 2. Mounting
- Open the **ChromeOS Files app**.
- Click the three-dot menu in the top right corner.
- Look for **"Add new service"** (or check under "Services" in the left sidebar).
- Select **ChromeOS Rclone**. This triggers the `onMountRequested` event.
- A new entry **"Rclone Mount"** should appear in the left sidebar under "My Computer".

### 3. Verification
- Click on **"Rclone Mount"**.
- You should see a single file named `test-file.txt`.
- Double-click the file to open it. It should display the text: `Hello from Rclone WASM!`.

### 4. Unmounting
- Click the **Eject icon** next to "Rclone Mount" in the Files app sidebar.
- The mount should disappear, and the `onUnmountRequested` event will be handled.

## Troubleshooting

- **Extension not loading:** Ensure you selected the `src` folder, not the root folder containing the license/readme files.
- **Fail to mount:** Open the extension's background page console (from `chrome://extensions/`) to view logs and errors.
- **Files app not showing "Add new service":** Ensure you are on a Chromebook (ChromeOS). This API is not fully functional on standard Chrome on Windows/Linux/macOS.
