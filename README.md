# Google SHSS

[English](README.en.md)

Google SHSS は、Google Workspace 内で HTML レポートや図をレビューするための Google Apps Script ウェブアプリです。文書の固定版とコメントを Google Drive に保存し、同じ版を開ける URL を共有できます。

- HTML、複数ページの ZIP、静的 SVG を取り込めます。
- テキストを選択したり、画像やグラフをドラッグで囲んだりしてコメントを付けられます。
- コメントと返信は **Ctrl+Enter** でも投稿できます。コメントは版・ページごとに管理されます。

## 必要なもの

- Apps Script と Google Drive が使える Google Workspace アカウント
- Node.js 22 と npm（ビルド用）
- 取り込んだ文書を保存する専用の Google Drive フォルダ

## ビルド

```sh
git clone https://github.com/soudai/google-shss.git
cd google-shss
npm ci
npm run build
node --check < dist/gas/Code.gs
```

`dist/gas/` に `Code.gs`、`Index.html`、`appsscript.json` が生成されます。

## Apps Script にデプロイ

1. [Apps Script](https://script.google.com/) でスタンドアロンのプロジェクトを作成します。「プロジェクトの設定」でマニフェストを表示し、生成した 3 ファイルを配置します。HTML ファイルの名前はエディタ上で `Index` にします。
2. 生成したマニフェストは [Advanced Drive Service（v3）](https://developers.google.com/apps-script/advanced/drive) を有効にします。標準 Google Cloud プロジェクトを関連付けている場合は、そのプロジェクトでも Google Drive API を有効にします。
3. 「プロジェクトの設定」から、次のスクリプト プロパティを追加します。

   | プロパティ | 値 |
   | --- | --- |
   | `SHSS_ROOT_FOLDER_ID` | 保存用 Drive フォルダの ID。フォルダ URL の `/folders/` の直後の部分です。 |
   | `SHSS_DOMAIN` | 利用者の Google Workspace メールドメイン。例は `example.com` です。 |

4. [新しいデプロイ](https://developers.google.com/apps-script/guides/web)で「ウェブアプリ」を選びます。実行ユーザーは **ウェブアプリにアクセスしているユーザー**、アクセスできるユーザーは **同じドメインのユーザー** に設定します。
5. 発行された `/exec` URL を対象アカウントで開き、Google Drive とメールアドレスの権限を許可します。

更新するときは生成ファイルを再配置し、「デプロイを管理」で既存のデプロイに新しいバージョンを割り当てます。配布済みの `/exec` URL を引き続き利用できます。

## 動作確認

1. 保存用フォルダにファイルを追加できるアカウントでウェブアプリを開きます。
2. 次を UTF-8 の `review-sample.html` として保存し、「取り込み」からファイルを選びます。

   ```html
   <!doctype html>
   <html lang="ja">
   <meta charset="utf-8">
   <title>レビューのサンプル</title>
   <p>この文章を選択して、コメントを投稿してください。</p>
   </html>
   ```

3. 文章を選択し、コメントを入力して **Ctrl+Enter** を押します。「保存しました」が表示されたら、ページを再読み込みして投稿を確認し、自分のコメントを削除します。
4. 別のアカウントで確認する場合は、Drive で対象の文書フォルダに閲覧権限を付与します。投稿を許可する相手には、そのフォルダ内の `comments.json` に編集権限も付与します。ウェブアプリの URL をコピーしても Drive の権限は変わりません。

## データと制限

- 取り込んだ文書、版情報、コメントは設定した Drive フォルダに保存されます。`comments.json` の編集権限がある利用者は Drive から直接ファイルを書き換えられます。アプリでのコメント削除は論理削除で、本文は JSON に残ります。
- 単一 HTML は UTF-8 で 2 MiB、静的 SVG は 512 KiB までです。ZIP は圧縮 5 MiB、展開後 20 MiB、100 ファイル、20 HTML ページまでです。Drive の URL やファイル ID から取り込めるのは単一 HTML です。
- ZIP には必要な画像、CSS、通常の JavaScript を同梱してください。外部 CDN や API、ES Modules、フォーム送信に依存するページは対象外です。HTML 内の JavaScript は隔離したプレビューで実行されるため、信頼できる作成者のファイルを使ってください。
- コメント本文は 2,000 文字までです。コメントの保存容量や操作履歴が上限に近づくと、新規投稿が制限されます。運用時は管理者だけが参照できる Drive フォルダへ定期的にバックアップしてください。

## ライセンス

[MIT](LICENSE)
