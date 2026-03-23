require("dotenv").config();

const fs = require("fs");
const path = require("path");
const https = require("https");
const { S3 } = require("@aws-sdk/client-s3");
const JSZip = require("jszip");

const {
    BUCKET_ENDPOINT,
    BUCKET_REGION,
    BUCKET_NAME,
    BUCKET_ACCESS_KEY_ID,
    BUCKET_SECRET_ACCESS_KEY,
} = process.env;

const s3Client = new S3({
    forcePathStyle: false,
    endpoint: `https://${BUCKET_ENDPOINT}`,
    region: BUCKET_REGION,
    credentials: {
        accessKeyId: BUCKET_ACCESS_KEY_ID,
        secretAccessKey: BUCKET_SECRET_ACCESS_KEY,
    },
});

const DOWNLOADS_DIR = path.join(__dirname, "..", "downloads");

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { "User-Agent": "CoffeeAddonAutoSync" } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return httpsGet(res.headers.location).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
        }).on("error", reject);
    });
}

async function fetchLatestGithubRelease(repo) {
    const url = `https://api.github.com/repos/${repo}/releases/latest`;
    const data = await httpsGet(url);
    return JSON.parse(data.toString());
}

async function downloadFile(url, destPath) {
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = await httpsGet(url);
    fs.writeFileSync(destPath, data);
    console.log(`downloaded: ${destPath} (${data.length} bytes)`);
}

async function getString(key) {
    try {
        const data = await s3Client.getObject({
            Bucket: BUCKET_NAME,
            Key: key,
        });
        return data.Body.transformToString();
    } catch (e) {
        console.error("error getting string:", key, e.message);
        return false;
    }
}

async function uploadString(key, str) {
    const result = await s3Client.putObject({
        ACL: "public-read",
        Bucket: BUCKET_NAME,
        Key: key,
        Body: Buffer.from(str, "utf-8"),
        ContentType: "plain/text",
    });
    console.log("uploaded string:", key);
}

async function uploadFile(localPath, remotePath, contentType) {
    const fileStream = fs.createReadStream(localPath);
    const result = await s3Client.putObject({
        ACL: "public-read",
        Bucket: BUCKET_NAME,
        Key: remotePath,
        Body: fileStream,
        ContentType: contentType,
    });
    console.log("uploaded file:", remotePath);
}

const PROVIDER_ID_FIELDS = [
    "X-Curse-Project-ID",
    "X-Wago-ID",
    "X-WoWI-ID",
    "X-Tukui-ProjectID",
    "X-Tukui-ProjectFolders",
];

const FINGERPRINT_MARKER = "-- CoffeeAddonSync managed\n";

function stripProviderIds(tocContent) {
    const lines = tocContent.split("\n");
    const filtered = lines.filter((line) => {
        const trimmed = line.trim();
        return !PROVIDER_ID_FIELDS.some((field) =>
            trimmed.toLowerCase().startsWith(`## ${field.toLowerCase()}:`)
        );
    });
    return filtered.join("\n");
}

async function processZip(zipPath) {
    const data = fs.readFileSync(zipPath);
    const zip = await JSZip.loadAsync(data);

    let tocCount = 0;
    let luaMarked = false;

    // collect top-level addon directories so we can add .git markers
    const topLevelDirs = new Set();

    for (const [filePath, file] of Object.entries(zip.files)) {
        // track top-level directories (e.g. "BigWigs_Core/" from "BigWigs_Core/foo.lua")
        const firstSlash = filePath.indexOf("/");
        if (firstSlash > 0) {
            topLevelDirs.add(filePath.substring(0, firstSlash));
        }

        if (file.dir) continue;

        if (filePath.endsWith(".toc")) {
            const content = await file.async("string");
            const stripped = stripProviderIds(content);
            if (content !== stripped) {
                zip.file(filePath, stripped);
                console.log(`  stripped provider IDs from ${filePath}`);
            }
            tocCount++;
        }

        // inject fingerprint marker into the first .lua file we find at the
        // shallowest depth to break CurseForge's MurmurHash2 fingerprint match
        if (!luaMarked && filePath.endsWith(".lua")) {
            const content = await file.async("string");
            if (!content.startsWith(FINGERPRINT_MARKER)) {
                zip.file(filePath, FINGERPRINT_MARKER + content);
                console.log(`  injected fingerprint marker into ${filePath}`);
                luaMarked = true;
            }
        }
    }

    // add empty .git directory to each top-level addon folder so WowUp
    // treats them as development addons and skips them during scanning
    for (const dir of topLevelDirs) {
        zip.file(`${dir}/.git/config`, "");
        console.log(`  added .git marker to ${dir}/`);
    }

    console.log(`  processed ${tocCount} .toc file(s), ${topLevelDirs.size} addon folder(s)`);

    const processed = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: { level: 9 },
    });
    fs.writeFileSync(zipPath, processed);
    console.log(`  rewrote ${zipPath} (${processed.length} bytes)`);
}

async function syncGithubAddon(addon) {
    console.log(`\n--- syncing ${addon.name} from github:${addon.repo} ---`);

    const release = await fetchLatestGithubRelease(addon.repo);
    const tag = release.tag_name;
    console.log(`latest release: ${tag}`);

    const pattern = new RegExp(addon.assetPattern);
    const asset = release.assets.find((a) => pattern.test(a.name));
    if (!asset) {
        console.error(`no matching asset for pattern ${addon.assetPattern} in release ${tag}`);
        console.error("available assets:", release.assets.map((a) => a.name).join(", "));
        return null;
    }

    const zipName = `${addon.name}-${tag}.zip`;
    const localPath = path.join(DOWNLOADS_DIR, zipName);
    const remotePath = `addons/${zipName}`;

    if (!fs.existsSync(localPath)) {
        console.log(`downloading ${asset.name}...`);
        await downloadFile(asset.browser_download_url, localPath);
        console.log(`processing zip to strip addon manager metadata...`);
        await processZip(localPath);
    } else {
        console.log(`already downloaded: ${localPath}`);
    }

    console.log(`uploading to S3: ${remotePath}`);
    await uploadFile(localPath, remotePath, "application/zip");

    return { name: addon.name, version: tag };
}

async function main() {
    const addonsConfig = JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "addons.json"), "utf-8")
    );

    const results = [];
    for (const addon of addonsConfig.addons) {
        try {
            const result = await syncGithubAddon(addon);
            if (result) results.push(result);
        } catch (e) {
            console.error(`failed to sync ${addon.name}:`, e.message);
        }
    }

    if (results.length === 0) {
        console.log("\nno addons were synced successfully");
        return;
    }

    // update manifest
    const currentManifestString = await getString("manifest.json");
    const manifest = currentManifestString
        ? JSON.parse(currentManifestString)
        : { AddOns: [] };

    for (const result of results) {
        let found = false;
        for (const addon of manifest.AddOns) {
            if (addon.Name === result.name) {
                console.log(`updating ${result.name} in manifest: ${addon.Version} -> ${result.version}`);
                addon.Version = result.version;
                found = true;
                break;
            }
        }
        if (!found) {
            console.log(`adding ${result.name} to manifest: ${result.version}`);
            manifest.AddOns.push({
                Name: result.name,
                Version: result.version,
            });
        }
    }

    const newManifestString = JSON.stringify(manifest, null, 2);
    if (currentManifestString === newManifestString) {
        console.log("\nmanifest already up to date");
    } else {
        console.log("\nupdating manifest.json");
        await uploadString("manifest.json", newManifestString);
    }

    console.log("\ndone!");
    for (const result of results) {
        const url = `https://${BUCKET_NAME}.${BUCKET_ENDPOINT}/addons/${result.name}-${result.version}.zip`;
        console.log(`${result.name}: ${url}`);
    }
}

main();
