# Google SHSS

[日本語](README.md)

Google SHSS is a Google Apps Script web app for reviewing HTML reports and figures within a Google Workspace domain. It stores document versions and comments in Google Drive and provides links that open a specific version.

The app interface is in Japanese.

## Screenshots and features

These screenshots show the app running locally with a fictional sales report.

### Comment on text

Select text in the preview to open the comment field on the right. Press **Ctrl+Enter** or click **投稿** (Post) to submit. Click a quoted passage in the sidebar to highlight it in the preview. You can reply to threads and delete your own posts.

![Report overview with a highlighted sentence and its comment thread and reply in the sidebar](docs/screenshots/text-comment.jpg)

### Comment on part of a figure

Choose **図にコメント** (Comment on a figure). Click an image or chart to select the whole figure, or drag to outline a smaller area. The screenshot shows a saved comment attached to the March bar.

![Detail page with a box around the March bar and the corresponding comment in the sidebar](docs/screenshots/region-comment.jpg)

### Open external references

Click an HTTPS link in a document to see the destination. Review the address, then select **別タブで開く** (Open in new tab).

### Import, navigate, and share

- Choose an HTML, ZIP, or static SVG file under **取り込み** (Import) to start checking it. If a ZIP has no default start page, select one. You can edit the title during upload and select **閉じる（取り込みは続行）** (Close and keep importing) to return to the library. Select **開く** (Open) in the completion notice to view the document.
- Switch between pages in a ZIP package using the page menu or links in the document. Comments are saved for each version and page.
- Use **版** (Versions) to open an earlier version or choose **新版を取り込む** (Import a new version) to update a document while keeping its previous versions and comments. Use **URLをコピー** (Copy URL) to share a direct link to the version and page you are viewing. Readers and commenters need the relevant Drive permissions.
- Use **プレビューを再読み込み** (Reload preview) to reset the HTML's interactive controls, such as tabs, to their initial state.

Use **保存状況** (Save status) to check progress and retry eligible failures. If SHSS could not confirm the outcome of an import, check the library before selecting the file again to avoid creating a duplicate.

### Display and save responsiveness

Previously fetched pages display from the current tab's memory cache. When recent comment data is available, you can post a new comment while the page is being revalidated. Confirmed comments also appear immediately when you return to a page. Failed posts restore your input and can be retried through **保存状況** (Save status). Keep the tab open until saving completes.

Large preview HTML is transferred with gzip compression. Drive reads are grouped, and comment saves check current permissions, the file version and checksum inside the write lock before reusing cached JSON. Initial loads and confirmed saves still depend on Apps Script, Drive and network latency; completion within one second is not guaranteed.

## Document library, search, and archives

The library shows previously fetched results while refreshing them. Search continues through later pages, including empty intermediate pages. Loading and connection failures are shown separately from an empty result. Use **再読み込み** (Reload) to refresh the library.

Choosing **アーカイブ** (Archive) moves the entire document folder into a dedicated `archive` folder inside the storage root. The normal library queries only the root's direct children, so archived documents, manifests and versions are excluded from its reads. The `archive` folder is searched only when the archive view is opened. **戻す** (Restore) moves the document back to the root.

```text
Storage root/
  Active document/
  archive/
    Archived document/
```

The dedicated folder is created on the first archive operation. Moving requires permission to move the document folder and add it to the destination. Document IDs, version links, HTML and comments are preserved. Archiving does not revoke sharing; access still follows Drive permissions after the move. Backups include both locations.

If required permissions were not selected during authorization, SHSS shows **アクセスを許可** (Authorize access) before loading documents. Review and grant the Google Drive and account information permissions, return to SHSS, and select **再読み込み** (Reload).

### Migrating older archives

Earlier versions kept archived folders in the storage root and marked them in the manifest. After updating and redeploying, the storage administrator should run **migrateArchivedDocuments_** in the Apps Script editor to move them into `archive`. Each run processes up to 20 documents. Repeat until the execution log reports `hasMore: false`. If `skipped` is nonzero, resolve the administrator's edit and move permissions first.

The migration changes folder placement and identification metadata without rewriting HTML, comments or manifest contents. Active documents stay in the root. Refresh both library views after completion. Each separately deployed domain needs its own Apps Script update, redeployment and migration. Before rolling back to a version without archive-folder support, restore archived documents to the normal library.

## Requirements

- A Google Workspace account with access to Apps Script and Google Drive
- Node.js 22 and npm to build the project
- A dedicated Google Drive folder for imported documents

## Build

```sh
git clone https://github.com/soudai/google-shss.git
cd google-shss
npm ci
npm run build
node --check < dist/gas/Code.gs
```

The build produces `Code.gs`, `Index.html`, and `appsscript.json` in `dist/gas/`.

`npm test` runs the tests for import sanitization, comment handling, Drive reads and the viewer UI. `npm run check` runs the tests, the build and the syntax check together.

### Run locally

```sh
npm run dev
```

Open http://localhost:8080/ to try the viewer without deploying to Apps Script. Documents are stored in memory instead of Google Drive and are lost when the server stops. Changes under `web/` appear when you reload the page; changes under `server/` and `scripts/` restart the server automatically. To simulate a slow network, add a delay in milliseconds to every request, for example `SHSS_DEV_DELAY=800 npm run dev`.

## Deploy to Apps Script

1. Create a standalone project in [Apps Script](https://script.google.com/). Enable manifest visibility in Project Settings and add the three generated files. Name the HTML file `Index` in the editor.
2. The generated manifest enables the [Advanced Drive Service (v3)](https://developers.google.com/apps-script/advanced/drive). If your script uses a standard Google Cloud project, enable the Google Drive API in that project as well.
3. Add the following script properties in Project Settings.

   | Property | Value |
   | --- | --- |
   | `SHSS_ROOT_FOLDER_ID` | The ID of the storage folder in Drive. Copy the part after `/folders/` in the folder URL. |
   | `SHSS_DOMAIN` | The Google Workspace email domain for your users, such as `example.com`. |

4. Create a [new web app deployment](https://developers.google.com/apps-script/guides/web). Set **Execute as** to **User accessing the web app** and limit access to **users in your domain**.
5. Open the generated `/exec` URL with an account in that domain and review the requested permissions. Parallel Drive reads use the external request scope and target the Drive API at `www.googleapis.com`. If a parallel download fails, SHSS reads the file through the Drive service.

To update the app, replace the generated files and assign a new version to the existing deployment under **Manage deployments**. The existing `/exec` URL will continue to work. When an update adds permissions to the manifest, each user is asked to grant them the next time they open the app.

## Try it

1. Open the web app with an account that can add files to the storage folder.
2. Save this sample as a UTF-8 file named `review-sample.html`. Choose **取り込み** (Import) and select the file.

   ```html
   <!doctype html>
   <html lang="en">
   <meta charset="utf-8">
   <title>Review sample</title>
   <p>Select this sentence and post a comment.</p>
   </html>
   ```

3. Select the sentence, type a comment, and press **Ctrl+Enter**. When **保存しました** (Saved) appears, reload the page, confirm the comment is there, and delete your own comment.
4. To test with another account, grant it Viewer access to the document folder in Drive. To let it post, also grant it Editor access to that document's `comments.json`. Copying the web app link does not change Drive permissions.

### Test a ZIP update alongside a comment save

1. Open **版** (Versions) in a test document and choose **新版を取り込む** (Import a new version). Select a ZIP with multiple pages and assets.
2. While the import is in progress, post a comment on a different test document in another tab. To test with multiple users, post from a second account with permission to comment.
3. Confirm that the comment shows **保存しました** (Saved) and the ZIP import completes. Open the first page and another page of the new version, then check that the previous version still opens.

## Data and limits

- Imported documents, version metadata, and comments are stored in your configured Drive folder. Users with edit access to `comments.json` can modify the file directly in Drive. Deleting a comment in the app hides it and retains its text in the JSON file.
- A single UTF-8 HTML file can be up to 10 MiB and a static SVG up to 512 KiB. ZIP limits are 10 MiB compressed, 20 MiB uncompressed, 100 files, and 20 HTML pages. Individual files inside ZIPs can be up to 2 MiB (512 KiB for SVGs). Importing from a Drive URL or file ID supports single HTML files.
- Include images, CSS, and classic JavaScript in the ZIP package. Pages that depend on external CDNs or APIs, ES modules, or form submission are outside the supported scope. HTML JavaScript runs in a sandboxed preview. Import files from authors you trust.
- Viewing documents does not take the write lock. New imports from local files and the creation of files for a new version also run outside the lock. Updates to shared data, such as comments and version metadata, run one at a time. If the server is busy, SHSS retries comments up to twice with the same operation ID. If a version upload hits a busy server, you can retry it from Save status.
- Comment bodies are limited to 2,000 characters. New posts are restricted as comment storage or operation history approaches its limits. Back up comment files regularly to a Drive folder accessible only to your administrators.

## License

[MIT](LICENSE)
