// OmniFiles - ChromeOS Rclone Integration
// Copyright (c) 2026 Markus Litz
// Licensed under the MIT License. See LICENSE file in the project root for details.

// config-schemas.js
// Defines the fields required to configure various rclone providers in the GUI.

const rcloneProviders = {
    drive: {
        name: "Google Drive",
        description: "Google Drive account",
        fields: [
            { name: "client_id", label: "Client ID", type: "text", placeholder: "Leave blank normally" },
            { name: "client_secret", label: "Client Secret", type: "password", placeholder: "Leave blank normally" },
            { name: "scope", label: "Scope", type: "select", options: [
                { value: "drive", label: "Full access all files" },
                { value: "drive.readonly", label: "Read-only access to file metadata and file contents" },
                { value: "drive.file", label: "Access to files created by rclone only" }
            ], default: "drive" },
            { name: "token", label: "OAuth Token", type: "textarea", placeholder: "Paste JSON token here (generate via 'rclone authorize drive' on a desktop)" },
            { name: "team_drive", label: "Team Drive ID", type: "text", placeholder: "Optional Shared Drive ID" }
        ]
    },
    onedrive: {
        name: "Microsoft OneDrive",
        description: "Microsoft OneDrive Personal or Business",
        fields: [
            { name: "client_id", label: "Client ID", type: "text", placeholder: "Leave blank normally" },
            { name: "client_secret", label: "Client Secret", type: "password", placeholder: "Leave blank normally" },
            { name: "region", label: "Region", type: "select", options: [
                { value: "global", label: "Global (default)" },
                { value: "us", label: "US Government" },
                { value: "de", label: "Germany" },
                { value: "cn", label: "China" }
            ], default: "global" },
            { name: "token", label: "OAuth Token", type: "textarea", placeholder: "Paste JSON token here (generate via 'rclone authorize onedrive' on a desktop)" }
        ]
    },
    s3: {
        name: "Amazon S3 (or compatible)",
        description: "Amazon S3, Ceph, DigitalOcean Spaces, Minio, etc.",
        fields: [
            { name: "provider", label: "S3 Provider", type: "select", options: [
                { value: "AWS", label: "Amazon Web Services (AWS) S3" },
                { value: "Ceph", label: "Ceph Object Storage" },
                { value: "DigitalOcean", label: "DigitalOcean Spaces" },
                { value: "Minio", label: "Minio Object Storage" },
                { value: "Wasabi", label: "Wasabi Object Storage" },
                { value: "Other", label: "Other S3 compatible provider" }
            ], default: "AWS" },
            { name: "access_key_id", label: "Access Key ID", type: "text" },
            { name: "secret_access_key", label: "Secret Access Key", type: "password" },
            { name: "region", label: "Region", type: "text", placeholder: "e.g. us-east-1" },
            { name: "endpoint", label: "Endpoint", type: "text", placeholder: "Leave blank for AWS. e.g. s3.us-west-1.wasabisys.com" },
            { name: "acl", label: "Canned ACL", type: "select", options: [
                { value: "private", label: "Private" },
                { value: "public-read", label: "Public Read" }
            ], default: "private" }
        ]
    },
    dropbox: {
        name: "Dropbox",
        description: "Dropbox cloud storage",
        fields: [
            { name: "client_id", label: "Client ID", type: "text", placeholder: "Leave blank normally" },
            { name: "client_secret", label: "Client Secret", type: "password", placeholder: "Leave blank normally" },
            { name: "token", label: "OAuth Token", type: "textarea", placeholder: "Paste JSON token here (generate via 'rclone authorize dropbox' on a desktop)" }
        ]
    },
    gcs: {
        name: "Google Cloud Storage",
        description: "Google Cloud Storage (GCS) - not Google Drive",
        fields: [
            { name: "project_number", label: "Project Number", type: "text", placeholder: "Optional" },
            { name: "service_account_credentials", label: "Service Account JSON", type: "textarea", placeholder: "Paste contents of your service account key file" },
            { name: "anonymous", label: "Anonymous Access", type: "select", options: [
                { value: "false", label: "No" },
                { value: "true", label: "Yes (public buckets)" }
            ], default: "false" }
        ]
    },
    googlephotos: {
        name: "Google Photos",
        description: "Google Photos API",
        fields: [
            { name: "client_id", label: "Client ID", type: "text", placeholder: "Leave blank normally" },
            { name: "client_secret", label: "Client Secret", type: "password", placeholder: "Leave blank normally" },
            { name: "token", label: "OAuth Token", type: "textarea", placeholder: "Paste JSON token here" }
        ]
    },
    crypt: {
        name: "Crypt (Encryption Overlay)",
        description: "Encrypts an existing remote or folder",
        fields: [
            { name: "remote", label: "Remote to encrypt", type: "remote_select", placeholder: "Pick an existing remote" },
            { name: "filename_encryption", label: "Filename Encryption", type: "select", options: [
                { value: "standard", label: "Standard (Recommended)" },
                { value: "off", label: "Off (No encryption)" },
                { value: "base32", label: "Base32" }
            ], default: "standard" },
            { name: "directory_name_encryption", label: "Directory Name Encryption", type: "select", options: [
                { value: "true", label: "True" },
                { value: "false", label: "False" }
            ], default: "true" },
            { name: "password", label: "Password", type: "password", placeholder: "Enter password", needsObscure: true },
            { name: "password2", label: "Salt (optional)", type: "password", placeholder: "Optional second password", needsObscure: true }
        ]
    }
};

window.rcloneProviders = rcloneProviders;
