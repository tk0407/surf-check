# 🏄 サーフチェック (Web)

エリア・日付・時間帯を選ぶと、関東のサーフポイントを波質スコアでランキング表示する静的Webアプリ。
「週間予報」タブでは、エリア内の各ポイントの7日分のスコアを朝・昼・夕で一覧でき、セルをタップすると詳細を表示する。
予報データは [Open-Meteo](https://open-meteo.com)（Marine + Forecast API）をブラウザから直接取得する（APIキー不要）。
実際に行った人の実況フィードバックの受け付けと補正の計算だけ、Cloudflare Worker（`worker/`）を使う。Worker が無くてもサイトは今までどおり動く。

公開: GitHub Pages（Settings → Pages → Deploy from a branch / `main` / root）。

## 構成

```
index.html        UI
style.css
scoring.js        採点ロジック
forecast.js       時間帯平均・週間予報の組み立て（ランキングと共用）
share.js          表示ラベルの整形、共有テキスト・共有カード・共有URLの組み立て
calibration.js    実況フィードバックからの補正の計算と、予報・採点へのかけ方（サイトと Worker で共用）
feedback.js       入力パネルの初期値、記録の組み立てと入力チェック、写真の EXIF 読み取り（サイトと Worker で共用）
feedback-panel.js 入力パネルの描画と操作、写真の縮小、送信（ブラウザ専用）
app.js            取得→描画、タブ切替
spots.json        スポットデータ
scoring.test.js   テスト（採点）
forecast.test.js  テスト（時間帯平均・週間予報）
share.test.js     テスト（共有テキスト・共有URL・復元）
spots.test.js     テスト（spots.json の形とライブカメラのURL）
calibration.test.js  テスト（補正の計算・かけ方・検証値）
feedback.test.js  テスト（初期値・入力チェック・EXIF・近いポイント）

worker/
  index.mjs       Worker の入口（handler.mjs に今の時刻を渡すだけ）
  handler.mjs     POST /feedback と GET /calibration、CORS、写真の保存と片付け
  quota.mjs       送信の回数・写真の大きさと容量の上限、写真の非常停止（D1 で数える）
  schema.sql      D1 のテーブル定義
  wrangler.toml   Worker 名、D1・R2 の紐づけ、ALLOWED_ORIGINS、R2_KILL_SWITCH
  d1-sqlite.mjs   テスト専用。Node 内蔵の node:sqlite を D1 と同じ呼び方で使う
  worker.test.mjs テスト（Worker）

docs/
  r2-security.md  写真（R2）のコスト対策、上限の変え方、管理画面での設定、緊急時の手順
```

## 共有機能

ランキング結果の下に「LINEで送る」「画像で共有」の2つのボタンがある。LINEで送ると、上位3件のポイント名・点数・波と風を短いテキストにまとめ、結果を再現できるURL（`?region=&date=&slot=`）を添えてLINEのトーク選択画面を開く。「画像で共有」は同じ上位3件を1080×1080のカード画像としてcanvasに描画し、対応する端末では共有シートから、それ以外ではダウンロードで保存できる。共有URLを開くとエリア・日付・時間帯が自動で入り、そのままチェックが実行されて同じランキングが再現される。

「週間予報」タブにも同じ「LINEで送る」「画像で共有」が付いている。共有されるのは各日のベスト（ポイント・時間帯・点数）の7行で、週で最も点数が高い日には★が付く。共有URLは `?region=...&mode=weekly` で、開くと週間予報タブが選ばれた状態でエリアが入る。ただし週間の共有URLには日付を入れていないため、表示される7日分は常に「開いた日から」になる。共有した翌日以降に開くと、エリアとタブは再現されるが期間はずれる。`mode` の付かないランキングの共有URLは日付・時間帯を含むので、従来どおり同じ内容が再現される。

## ライブカメラ

検索結果のカードの一番下に「ライブカメラ」の行が出る。リンクは別タブで開く（埋め込み再生はしない）。出典は `spots.json` の `cams` に持たせてあり、1ポイントあたり最大2本。並びは優先度順（YouTube → Surfers Ocean → BCM）で、先頭から2本を出す。カメラが無いポイント、名前の一致する生きたカメラが見つからなかったポイントでは行ごと出さない（32ポイント中26ポイントに行が出る）。

```json
{ "name": "部原", "cams": [{ "label": "YouTube サンセット", "url": "https://..." }] }
```

リンク先は YouTube のライブ配信、Surfers Ocean のポイント別ページ、BCM SurfPatrol の `wave-detail` ページの3種類。いずれも無料で見られる。`spots.test.js` がホスト・本数・https・エリアをまたぐ使い回しをテストで止めている。ライブ配信は止まることがあるので、リンク切れに気づいたら `spots.json` を直す。

## 実況フィードバックと補正

ランキングの各カードの一番下に「行ってきた」ボタンがある。押すと入力パネルが下から開き、その回の総合評価（1〜5）・波のサイズ・風向き（オフ／サイド／オン）・風の強さ・写真1枚（任意）を送れる。波・風の初期値はカードに出ていた予報なので、予報どおりだったなら総合を選んで「送る」の2タップで済む。潮は入力も記録もしない。

- 同じ端末・ポイント・日付・時間帯で送り直すと上書きになる（ボタンのラベルが「送り直す」に変わる）。
- まだ一度も送れていない端末でだけ、名前の欄（任意・20文字まで）が出る。入れた名前は端末に覚えさせ、以後の送信にも付けて記録に残す。
- 写真は長辺1600pxの JPEG に縮めてから送り、EXIF は残さない。元の写真から撮影時刻が読めれば日付と時間帯を合わせ、撮影位置が選んだポイントから1.0kmを超えて離れていて、ほかのポイントの方が近ければ、そちらに切り替える提案を出す。iPhone の Safari などは位置情報を消してから渡すことが多いので、読めたら使う扱い。写真を置いたときは、元の写真から読めた撮影位置と撮影時刻も記録に残す。
- 送信は1端末・1回線ごとに1分5件まで、1日は1端末20件・1回線30件・全体100件まで。写真は1枚1.5MBまで。写真の容量の上限（1日・合計）に当たったときと、写真の非常停止中は、記録だけ保存して写真は置かない。数と変え方は [docs/r2-security.md](docs/r2-security.md)。

貯まった記録（予報と実況の組）から、Worker の `GET /calibration` がその都度次の補正を計算する。

- ポイントごとの波サイズの倍率（0.5〜2倍）と風速のずれ（±4m/s）。件数が少ないうちは「補正なし」側へ強く寄せる。
- ランキングの配点（風向き・風速・うねりの向き・周期・波高、合計85点）。15件貯まるまでは今の配点のまま。

サイトは起動時に補正を読み（最大2秒待つ）、ランキング・週間予報・共有テキストと共有画像にかける。記録のあるポイントのカードには「実況補正 7件（波×1.2・風+0.6m/s）」のように出る。補正が読めないとき、記録が0件のときは、表示も点数も補正なしと同じ。補正の計算には必ず補正前の予報を使う。`scoring.js` は変えていない。

補正の効果は `GET /calibration?metrics=1` で見られる（記録を1件ずつ抜いて残りで予測する leave-one-out）。`wave_band_mae` の `calibrated` が `raw` より小さく、`rating_concordance` の `calibrated` が `default` より大きければ、補正が効いている。

記録が増えて leave-one-out の計算が Workers Free プランの CPU 上限（1リクエスト10ms）に収まらなくなったら（だいたい100〜150件が目安）、`?metrics=1` は 1102 エラーになる。そのときは `worker/metrics.mjs` で同じ計算をローカルで行う（SELECT は `handler.mjs` の `CALIBRATION_COLUMNS` を共用しているので、集計対象は `GET /calibration` と同じ）。

```bash
cd worker
npx wrangler@4 d1 execute surf-check-feedback --remote --json --command "$(node metrics.mjs --sql)" | node metrics.mjs
```

`app.js` の `FEEDBACK_API` が空文字のときは補正を取りに行かず、「行ってきた」ボタンも出さない。記録や写真を見る画面は無い。写真は Cloudflare の管理画面（R2）で見る。

## ローカルで動かす

```bash
python -m http.server 8000
# http://localhost:8000/
```

フィードバックまで試すときは、Worker もローカルで立てる（ローカルの D1 と R2 を使う）。

```bash
cd worker
# 開発用の設定。.gitignore 済み。IP_SALT はその場で作った使い捨ての値にする
printf 'ALLOWED_ORIGINS=http://localhost:8000\nIP_SALT=%s\n' "$(openssl rand -hex 16)" > .dev.vars
npx wrangler@4 d1 execute surf-check-feedback --local --file schema.sql
npx wrangler@4 dev
# http://localhost:8787/calibration?metrics=1
```

`app.js` の `FEEDBACK_API` を一時的に `"http://localhost:8787"` にして試す（この変更はコミットしない）。送った記録と写真は次で確かめられる。

```bash
npx wrangler@4 d1 execute surf-check-feedback --local --command "SELECT id, spot, date, slot, rating, wave_band, photo_key FROM feedback"
npx wrangler@4 r2 object get surf-check-photos/<photo_key> --local --file /tmp/photo.jpg
```

## テスト

```bash
node --test
```

`fail 0` で全件成功すること。件数はテストを足すたびに変わるので、ここには書かない。

## フィードバック用 Worker の公開

Cloudflare のアカウントと `npx wrangler@4 login` が済んでいる前提。コマンドは `worker/` で実行する。

1. `npx wrangler@4 d1 create surf-check-feedback` を実行し、出力された `database_id` を `wrangler.toml` に書く。
2. `npx wrangler@4 r2 bucket create surf-check-photos`
3. `npx wrangler@4 d1 execute surf-check-feedback --remote --file schema.sql`
4. `openssl rand -hex 32 | npx wrangler@4 secret put IP_SALT`。値は画面にもファイルにも出さずに渡す（回線ごとの回数制限に使う IP のハッシュの塩）。
5. `npx wrangler@4 deploy`
6. 表示された URL（`https://surf-check-feedback.<アカウント>.workers.dev`）を `app.js` の `FEEDBACK_API` に入れ、`index.html` の `?v=` を上げて GitHub Pages に出す。

`ALLOWED_ORIGINS`（`wrangler.toml`）はサイトのオリジンだけにしてある。サイトのドメインを変えたら、ここも直して `deploy` し直す。

公開したら、[docs/r2-security.md](docs/r2-security.md) の「管理画面での設定」にそって、R2 のバケットが非公開のままか（r2.dev が無効で、ドメインが付いていない）を確かめ、予算アラートを作る。写真を止める・受け付けを止めるときの手順も同じ文書にある。

### 記録の消し方

頼まれて消すときは、先に写真の名前を控えてから消す。`<端末ID>` は `SELECT id, device_id, name, spot, date, slot FROM feedback ORDER BY updated_at DESC LIMIT 20` などで探す。

```bash
# ある端末の記録
npx wrangler@4 d1 execute surf-check-feedback --remote --command "SELECT photo_key FROM feedback WHERE device_id = '<端末ID>' AND photo_key IS NOT NULL"
npx wrangler@4 r2 object delete surf-check-photos/<photo_key> --remote   # 控えた写真ごとに
npx wrangler@4 d1 execute surf-check-feedback --remote --command "DELETE FROM feedback WHERE device_id = '<端末ID>'"

# 日付の範囲で消す（写真は同じ条件の SELECT photo_key で控えてから消す）
npx wrangler@4 d1 execute surf-check-feedback --remote --command "DELETE FROM feedback WHERE date BETWEEN '2026-10-01' AND '2026-10-07'"
```

消したあとは、[docs/r2-security.md](docs/r2-security.md) の「数のずれを直す」の2で写真の容量の合計を作り直す。やらないと、消した写真のぶんが上限の計算に残る。

### ポイント名を変えたとき

記録はポイントを名前で持っている。`spots.json` で名前を変えたら、記録側も書き換える。書き換えなくてもエラーにはならないが、そのポイントに補正がかからなくなる。

```bash
npx wrangler@4 d1 execute surf-check-feedback --remote --command "UPDATE feedback SET spot = '<新しい名前>' WHERE spot = '<古い名前>'"
```

同じ端末が同じ日付・時間帯に古い名前と新しい名前の両方で既に送っていると、その組だけ `(device_id, spot, date, slot)` の UNIQUE 制約に引っかかり、UPDATE ごと失敗する。先に次で探し、見つかったら該当行のどちらかを手で消すか日付・時間帯をずらしてから UPDATE を流す。

```bash
npx wrangler@4 d1 execute surf-check-feedback --remote --command "SELECT a.id AS old_id, b.id AS new_id, a.device_id, a.date, a.slot FROM feedback a JOIN feedback b ON a.device_id = b.device_id AND a.date = b.date AND a.slot = b.slot WHERE a.spot = '<古い名前>' AND b.spot = '<新しい名前>'"
```

## スポット・採点ロジックの大元

このリポジトリは公開用。スポット定義(`spots.yaml`)と採点ロジック(Python版)の出所は
別プロジェクト `notion_tools` 側。スポットを更新する場合はそちらで `spots.json` を再生成し、
`spots.json`（および変更時は `scoring.js`）を本リポジトリへ反映する。

**注意:** `cams`（ライブカメラ）は `notion_tools` 側には無く、本リポジトリの `spots.json` にだけ持たせている。`spots.json` を再生成するときは `cams` を消さないこと。`spots.test.js` に「どのエリアにもカメラ付きのポイントが1つ以上ある」テストを置いてあるので、丸ごと落ちた場合はテストが落ちる。

## データソース

Open-Meteo の GFS-Wave 系の数値予報モデル。実測値ではない点に注意。
