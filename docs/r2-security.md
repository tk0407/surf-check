# 写真（R2）のコスト対策と緊急時の手順

実況フィードバックの写真を置く Cloudflare R2 について、どこでお金がかかるか、どう抑えているか、何かあったときに何をするかをまとめる。コマンドはすべて `worker/` で実行する。料金と無料枠は 2026年9月に Cloudflare のドキュメントで確かめた値。

## 構成

```
ブラウザ（GitHub Pages のサイト）
  │ POST /feedback（記録 + 写真1枚まで）      GET /calibration（補正）
  ▼                                           ▼
Cloudflare Worker（surf-check-feedback）
  ├─ D1（surf-check-feedback）：記録、送信の数、写真の容量の合計
  └─ R2（surf-check-photos）：写真。Worker が put と delete をするだけ
```

- R2 に書くのは Worker だけ。写真の名前（`photos/<ランダムな UUID>.jpg`）は Worker が作る。送る側が書いた名前やファイル名は使わない。
- 写真を外に出す口は無い。公開 URL（r2.dev）、自分のドメイン、署名付き URL、写真を返す API のどれも作っていない。写真を見るのは Cloudflare の管理画面だけ。
- Worker は R2 の一覧（List）を呼ばない。容量は D1 の `storage_usage` で数える。
- 送る人のログインは無い（誰でも送れる、という仕様）。そのぶん、回数・大きさ・容量の上限で抑える。

## お金がかかるところ

| 何に | 無料枠（1か月） | 超えた分 | この Worker が使う量 |
|---|---|---|---|
| R2 の保存容量 | 10GB | $0.015/GB | 写真の合計。`GLOBAL_STORAGE_LIMIT`（既定 5GB）で止める |
| R2 の Class A（put・list） | 100万回 | $4.50/100万回 | 写真を置くたびに1回。1日 `GLOBAL_DAILY_COUNT_LIMIT`（既定 100）回まで |
| R2 の Class B（get） | 1000万回 | $0.36/100万回 | Worker は読まない。管理画面で見たときだけ |
| R2 の delete・転送量 | 無料 | 無料 | 写真の差し替え・片付け |
| Workers のリクエスト | 無料プランは1日10万件 | 無料プランは超えるとエラー（請求なし）。有料プランは1000万件/月を超えた分が $0.30/100万件 | POST・GET とも1件ずつ |
| D1 の読み取り | 無料プランは1日500万行 | 無料プランは超えるとエラー。有料プランは250億行/月を超えた分が $0.001/100万行 | POST は1回数百行。GET /calibration は記録の全件 |
| D1 の書き込み | 無料プランは1日10万行 | 無料プランは超えるとエラー。有料プランは5000万行/月を超えた分が $1.00/100万行 | 受け付けた送信1件で数行 |

既定の上限のままなら、R2 は無料枠を超えない。put は多くても1日100回（1か月3,100回）で、容量は 5GB で止まる。Workers と D1 は、無料プランなら上限でエラーになるだけで請求は来ない。

## 守り

POST /feedback は次の順に確かめる。先の段で断れば、後の段（とくに R2）には進まない。

1. 設定：`IP_SALT` が無い、上限の変数が整数として読めないときは 500 を返し、何も保存しない。
2. 大きさ：`Content-Length` が `MAX_UPLOAD_SIZE` + 512KB を超えていれば読まずに 413。宣言が無くても、読みながら数えて超えた時点で読むのをやめて 413。
3. 中身：記録を検証する（400）。写真は `MAX_UPLOAD_SIZE` を超えれば 413、先頭が JPEG（`FF D8 FF`）でなければ 415。
4. 回数と容量：D1 の1回のトランザクションで、上限を確かめて、送信を記録し、写真の容量を足す。同時に何件来ても、上限を超えて通ることはない。回数の上限に当たれば 429。容量の上限に当たったとき、非常停止中のときは、写真を置かずに記録だけ受け付ける（下の「写真だけ置かない場合」）。
5. R2 に put する。失敗したら、置きかけた写真を消し、足した容量を戻して 500。
6. D1 に記録を保存する。失敗したら、置いた写真を消し、容量を戻して 500。
7. 後片付け：3日より前の送信の記録を消す。同じ組の送り直しで写真が差し替わったら、古い写真を消して容量を戻す。ここでの失敗はログに残すだけで、送信は成功のまま返す。

Worker は D1 と R2 への呼び出しをやり直さない（リトライ0回）。送り直すかどうかは送った人が決める。同じ端末・ポイント・日付・時間帯の記録は1件だけで、送り直すと上書きになる（写真も差し替え）。

写真を消せなかったときは、その写真の容量を数えたままにする（多めに数える側に倒す）。消せなかった写真の名前はログ（`photo_orphan`）に出るので、「数のずれを直す」の手順で片付ける。

### 上限と環境変数

上限は `worker/quota.mjs` の `DEFAULT_LIMITS` が既定値。変えるときは、同じ名前の変数を `wrangler.toml` の `[vars]` に文字列で書いて deploy する。空文字は既定値に戻る。整数として読めない値（`"10MB"`、`"1.5"`、`"-1"`、`"1e6"`）を入れると、Worker は 500 を返して何も保存しない。

| 変数 | 既定値 | 数えるもの | 超えたとき |
|---|---|---|---|
| `MAX_UPLOAD_SIZE` | 1572864（1.5MB） | 写真1枚の大きさ。10485760（10MB）より大きくはできない | 413 |
| `MINUTE_COUNT_LIMIT` | 5 | 1端末の、また1回線の、直近60秒の送信 | 429（`device_minute` / `ip_minute`） |
| `DAILY_UPLOAD_COUNT_LIMIT` | 20 | 1端末の1日（日本時間）の送信 | 429（`device`） |
| `IP_DAILY_COUNT_LIMIT` | 30 | 1回線の1日の送信 | 429（`ip`） |
| `GLOBAL_DAILY_COUNT_LIMIT` | 100 | 全員の1日の送信 | 429（`total`） |
| `DAILY_UPLOAD_LIMIT` | 10485760（10MB） | 1端末の1日の写真の合計 | 写真だけ置かない（`device_bytes`） |
| `GLOBAL_DAILY_UPLOAD_LIMIT` | 104857600（100MB） | 全員の1日の写真の合計 | 写真だけ置かない（`global_bytes`） |
| `USER_STORAGE_LIMIT` | 209715200（200MB） | 1端末が R2 に置いている写真の合計 | 写真だけ置かない（`device_storage`） |
| `GLOBAL_STORAGE_LIMIT` | 5368709120（5GB） | R2 に置いている写真の合計 | 写真だけ置かない（`global_storage`） |

ほかの変数：

| 変数 | 置き場所 | 中身 |
|---|---|---|
| `ALLOWED_ORIGINS` | `wrangler.toml` | POST を受け付けるサイトのオリジン（カンマ区切り）。ブラウザ以外からの送信は止められないので、守りは上の上限が受け持つ |
| `IP_SALT` | secret（`wrangler secret put`） | 回線ごとの数え方に使う IP のハッシュの塩。D1 には IP そのものは入らない |
| `R2_KILL_SWITCH` | `wrangler.toml` | `"false"` か `"0"` のときだけ写真を置く。それ以外（`"true"`、空、書き忘れ）は写真を置かない |

回数の上限は、429 を返した送信は数えない。1日の区切りは日本時間の0時。

### 写真だけ置かない場合

容量の上限か非常停止に当たったとき、Worker は記録を保存し、写真は置かずに 200 を返す。返事には理由が付く。

```json
{ "ok": true, "id": 12, "updated": false, "photo_skipped": "kill_switch" }
```

入力パネルは「送りました。写真は今は受け付けていないため、記録だけ保存しました」と出し、自動では閉じない。記録（予報と実況の組）は補正に使えるので、写真が無くても受け付ける方を選んだ。

## 管理画面での設定

コードでは決められないので、公開の前に手で確かめる。

1. **予算アラート（通知だけ）**：Manage Account → Billing → Billable Usage → Create budget alert で、$1・$5・$10 のように金額で作る。従量課金のアカウントだけで使える。届くのは1日ほど遅れることがあり、**超えても止まらない**。守りは上の上限と非常停止で、アラートは気づくためのもの。
2. **R2 のバケットを公開しない**：作ったばかりのバケットは非公開で、r2.dev の公開 URL も切れている。そのままにする。確かめるには次を実行し、r2.dev が無効で、ドメインが1つも無いことを見る。
   ```bash
   npx wrangler@4 r2 bucket dev-url get surf-check-photos
   npx wrangler@4 r2 bucket domain list surf-check-photos
   ```
3. **ライフサイクル**：作ったばかりのバケットには、途中で止まったマルチパートのアップロードを7日で消すルールが入っている。それだけにする。日数で写真を消すルールは足さない。R2 だけで消えると、D1 の記録と容量の合計がずれるため。写真を減らしたいときは「古い写真を減らす」の手順で消す。
   ```bash
   npx wrangler@4 r2 bucket lifecycle list surf-check-photos
   ```
4. **API トークン**：この構成では作らない。公開は `npx wrangler@4 login` のブラウザでのログインで行う。R2 の API トークン（R2 → Account Details → API Tokens → Manage）が1つも無いことを確かめる。あとで自動 deploy などにトークンが要るときは、このアカウントとこの Worker・D1 だけに絞り、期限を付ける。
5. **自分のドメイン**：付けない。Worker は `workers.dev` のまま、R2 には付けない。
6. **キャッシュ**：設定は要らない。写真を返す口が無いので、写真の配信のキャッシュは無い。`GET /calibration` はブラウザ向けに5分のキャッシュの指示を返す。Worker の中のキャッシュ（Cache API）は `workers.dev` では働かないので使っていない。
7. **WAF**：`workers.dev` のままでは使えない（WAF は自分のドメインに付けるもの）。有料プランに移すときに、Worker を自分のドメインにつなぎ、`/feedback` と `/calibration` にレート制限を付けることを考える（そのときの Cloudflare のドキュメントで確かめる）。

## 見張る

- **ログ**：`npx wrangler@4 tail` で今の送信をその場で見られる（無料）。Worker は1回の送信ごとに JSON を1行出す。端末 ID・名前・IP・IP のハッシュ・記録の中身は出さない。

  | event | 出るとき | 中身 |
  |---|---|---|
  | `feedback` | 送信ごと | `status`、`limit`（429 のとき）、`photo_skipped`、`photo_bytes`、`updated` |
  | `config_error` | 変数が無い・読めない | `variable`（変数の名前） |
  | `r2_error` | 写真を置けなかった | `error`（例外の名前と文、200文字まで） |
  | `d1_error` | 記録の保存か後片付けに失敗した | `error` |
  | `photo_orphan` | 写真を消せなかった | `key`（写真の名前）、`error` |
  | `error` | 想定外の例外 | `error` |

  `error` には D1 そのものの失敗（`reserve` の上限チェック、`release` の容量の書き戻し）も含む。どちらも個別のログにはせず、この汎用の `error` として出る。

- **R2 の量**：管理画面の R2 → surf-check-photos → Metrics で、写真の数と合計の大きさが見られる（List を呼ばないので Class A を使わない）。D1 の数と比べる。
  ```bash
  npx wrangler@4 d1 execute surf-check-feedback --remote --command "SELECT used_bytes, file_count FROM storage_usage WHERE scope = 'global'"
  ```
  R2 の方が多ければ、消せなかった写真（`photo_orphan`）があるか、Worker 以外が書いている（「トークンが漏れたとき」を見る）。
- **送信の様子**：直近4日の、日ごとの送信の数・写真の合計・写真を置かなかった数。
  ```bash
  npx wrangler@4 d1 execute surf-check-feedback --remote --command "SELECT day, COUNT(*) AS sends, SUM(photo_bytes) AS photo_bytes, COUNT(photo_skipped) AS skipped FROM submissions GROUP BY day ORDER BY day"
  ```
- **Workers と D1**：管理画面の Workers & Pages → surf-check-feedback → Metrics でリクエストとエラーの数、D1 → surf-check-feedback → Metrics で読み書きの行数が見られる。

## 数のずれを直す

`storage_usage` がずれるのは、写真を消せなかったとき（多めに数える）と、記録や写真を手で消したとき。順番に直す。

1. ログの `photo_orphan` に出た写真の名前ごとに、記録から使われていないことを確かめてから消す。
   ```bash
   npx wrangler@4 d1 execute surf-check-feedback --remote --command "SELECT id FROM feedback WHERE photo_key = '<key>'"
   # 何も返らなければ消す
   npx wrangler@4 r2 object delete surf-check-photos/<key> --remote
   ```
2. 作り直す前に、`storage_usage` の `global` と、今の記録から計算した合計を比べる。
   ```bash
   npx wrangler@4 d1 execute surf-check-feedback --remote --command "SELECT (SELECT used_bytes FROM storage_usage WHERE scope = 'global') AS storage_bytes, (SELECT file_count FROM storage_usage WHERE scope = 'global') AS storage_count, (SELECT COALESCE(SUM(photo_bytes), 0) FROM feedback WHERE photo_key IS NOT NULL) AS feedback_bytes, (SELECT COUNT(*) FROM feedback WHERE photo_key IS NOT NULL) AS feedback_count"
   ```
   差があれば、1で拾えなかった、ログにも出ていない孤児がある（`photo_orphan` に出た写真は1で片付いているので、それでも残る差は未知の孤児）。差が大きければ、作り直す前に管理画面の R2 → surf-check-photos でバケットの中身を見て、`feedback.photo_key` に無いキーを探す。
3. 記録から合計を作り直す。1の前にやると、消せていない写真のぶんが数から抜けるので、必ず1の後に行う。途中で止まっても、同じコマンドをもう一度流せば作り直せる（最初に全部消してから数え直すため）。
   ```bash
   npx wrangler@4 d1 execute surf-check-feedback --remote --command "DELETE FROM storage_usage; INSERT INTO storage_usage (scope, used_bytes, file_count) SELECT 'global', COALESCE(SUM(photo_bytes), 0), COUNT(*) FROM feedback WHERE photo_key IS NOT NULL; INSERT INTO storage_usage (scope, used_bytes, file_count) SELECT 'device:' || device_id, SUM(photo_bytes), COUNT(*) FROM feedback WHERE photo_key IS NOT NULL GROUP BY device_id"
   ```
4. 「見張る」の R2 の Metrics と、`storage_usage` の `global` が合っていることを見る。

### 古い写真を減らす

日付を決めて、写真の名前を控え、R2 から消し、記録から外し、合計を作り直す。記録（予報と実況）は残るので補正には影響しない。

```bash
npx wrangler@4 d1 execute surf-check-feedback --remote --command "SELECT photo_key FROM feedback WHERE photo_key IS NOT NULL AND date < '2027-01-01'"
npx wrangler@4 r2 object delete surf-check-photos/<photo_key> --remote   # 控えた写真ごとに
npx wrangler@4 d1 execute surf-check-feedback --remote --command "UPDATE feedback SET photo_key = NULL, photo_bytes = NULL, photo_lat = NULL, photo_lon = NULL, photo_taken_at = NULL WHERE photo_key IS NOT NULL AND date < '2027-01-01'"
```

そのあと「数のずれを直す」の3と4を行う。

## 緊急時の手順

### A. 写真だけ止める（非常停止）

記録は受け付けたまま、R2 への put を止める。

```bash
# wrangler.toml の R2_KILL_SWITCH = "false" を "true" に書き換えてから
npx wrangler@4 deploy
```

- 急ぐときは管理画面の Workers & Pages → surf-check-feedback → Settings → Variables and Secrets で `R2_KILL_SWITCH` を `true` にしてもよい（保存するとすぐ新しい版になる）。ただし、次に `wrangler deploy` すると `wrangler.toml` の値に戻るので、あとで `wrangler.toml` も同じにする。
- 止まったかは、`npx wrangler@4 tail` を開いたまま写真付きで1件送り、`"photo_skipped":"kill_switch"` が出ることで確かめる。
- 戻すときは `"false"` にして deploy する。

### B. 受け付けごと止める

`wrangler.toml` の `[vars]` に `GLOBAL_DAILY_COUNT_LIMIT = "0"` を書いて deploy する。すべての POST が 429（「今日はこれ以上送れません」）になり、R2 にも D1 の記録にも何も書かない。`GET /calibration` は動いたままなので、サイトの補正はそのまま出る。戻すときはその行を消して deploy する。

### C. Worker ごと止める

Worker そのものへのリクエストが多すぎるとき（有料プランで請求が増えている、D1 の読み取りの上限に当たっている）。`wrangler.toml` に `workers_dev = false` を書いて deploy すると、`workers.dev` の URL が答えなくなる。管理画面だけで止めると次の `wrangler deploy` で元に戻るので、`wrangler.toml` で止める。サイトは補正なし（Worker が無いときと同じ表示）で動き続け、「行ってきた」からの送信は「送れませんでした」になる。

### D. トークンが漏れたとき

Cloudflare のトークンやログインが漏れると、Worker を通らずに R2 に直接書ける。上の上限は効かない。

1. My Profile → API Tokens（自分のトークン）、Manage Account → API Tokens（アカウントのトークン）、R2 → Account Details → API Tokens → Manage（R2 のトークン）で、知らないトークン・使っていないトークンを消す（ロールする）。
2. `npx wrangler@4 logout` のあと `npx wrangler@4 login` でログインし直す。
3. R2 の Metrics で写真の数と大きさを見て、D1 の `storage_usage` より多ければ、管理画面のバケットの中身を見て知らない物を消す。
4. Workers & Pages → surf-check-feedback → Deployments で、自分の知らない deploy が無いか見る。あれば手元から `npx wrangler@4 deploy` し直す。
5. D1 の中身を持ち出されたおそれがあれば、`IP_SALT` を取り替える（`openssl rand -hex 32 | npx wrangler@4 secret put IP_SALT`）。取り替えたその日は、回線ごとの数え方が0からになる。

### 原因を調べる

- `npx wrangler@4 tail` で `feedback` の `status` と `limit`、`photo_skipped` を見る。429 の `total` が続くなら誰かが全体の上限を埋めている。`device_minute` が1台から続くならその端末の暴走。
- 「見張る」の送信の様子の SQL で、日ごとの数と写真の合計を見る。

## 被害はどこまで広がるか

既定の上限のままの場合。

**Worker の API が攻撃されたとき**
- R2：put は1日100回、写真の追加は1日100MB、合計は5GBで止まる。無料枠（100万回、10GB）の中なので R2 の請求は $0。
- 無料プランの Workers と D1：請求は来ない。全体の1日100件を埋められると、その日（日本時間0時まで）はほかの人が送れない。Workers の1日10万件か D1 の1日の読み取りを使い切られると、リセットまで補正も送信も止まる（Workers は UTC の0時、日本時間の9時にリセット）。サイトそのもの（GitHub Pages と Open-Meteo）は動き続け、補正なしの表示になる。
- 有料プランにした場合：リクエストと D1 の読み取りが、攻撃の量に比例して請求される。とくに `GET /calibration` は1回で記録の全件を読む（記録が1000件なら、100万回で10億行、約 $1）。有料プランに移すなら、先に「残るリスク」の1を片付けるか、C の手順をすぐ使えるようにしておく。

**バグで暴走したとき**
- 入力パネルが送信を繰り返すようなバグ：1端末は1分5件・1日20件、写真は1日10MBで止まる。全体でも上と同じ量で止まる。
- Worker のコードが上限を通らずに R2 に書くようなバグ：上限は効かない。テスト（`worker/worker.test.mjs`）で put の回数と容量の数を確かめて防いでいる。起きたら A で写真を止め、それでも止まらなければ C。

**トークンが漏れたとき**
- Worker の外なので、上限も非常停止も効かない。R2 の容量と操作の回数は、漏れたトークンの使われ方しだいで、上限が無い。
- 気づく手段は、予算アラート（1日ほど遅れる。止めはしない）と、R2 の Metrics と D1 の `storage_usage` の比べ合わせ。
- D の手順でトークンを消す。R2 の API トークンを作らないこと、トークンに期限と対象の絞り込みを付けることで、漏れる物を減らしておく。

予算アラートは守りではない。届いたときにはもう請求が発生していて、止まりもしない。

## 残るリスク

1. **`GET /calibration` が毎回全件を読む（中）**：無料プランでは上限に当たって止まるだけだが、有料プランでは読み取りが請求される。計算結果を D1 に保存して数分ごとにだけ計算し直す、という直し方がある。今は記録が少なく無料プランなので、手を付けていない。
2. **端末 ID は送る側が決める**：ID を変えれば、端末ごとの上限は避けられる。回線ごと・全体の上限で抑えている。
3. **回線を共有する人**：携帯の回線や同じ Wi-Fi の人は、回線ごとの上限（1分5件・1日30件）を一緒に使う。
4. **無料プランでの妨害**：上の「攻撃されたとき」のとおり、請求は来ないが、その日は送れなくなる。
5. **写真の中身**：確かめているのは JPEG の先頭と大きさだけ。EXIF はブラウザが消してから送るが、ブラウザを通さずに送られた写真には残っていることがある。写真は公開していない。
6. **手で消したときの数のずれ**：「数のずれを直す」で直す。
7. **`GET /calibration?metrics=1` は誰でも呼べる**：認証は無い。leave-one-outで記録ごとに計算し直すため、記録1000件でおよそ0.4秒のCPU時間を使う。無料プランは1リクエスト10msなので、その前に1102エラーになり請求は無い。有料プランでは叩かれた回数ぶん課金されるので、`?metrics=1` を頻繁に呼ぶ外部の仕組みは作らない（オフライン計算は `worker/metrics.mjs`、README を参照）。
8. **`spot` は形だけ確認している**：Worker が確かめるのは1〜40文字という形だけで、`spots.json` にある名前かどうかは見ていない。無い名前で送られても記録として保存され、`GET /calibration` にも出る。サイトは自分の知っている名前しか探さないので表示には影響しないが、気づいたら次で消す。
   ```bash
   npx wrangler@4 d1 execute surf-check-feedback --remote --command "SELECT DISTINCT spot FROM feedback"
   # spots.json に無い名前があれば
   npx wrangler@4 d1 execute surf-check-feedback --remote --command "DELETE FROM feedback WHERE spot = '<無い名前>'"
   ```

## この構成で使っていないもの

- 署名付き URL（presigned URL）：写真は Worker が受け取って put する。R2 に直接上げさせない。
- 写真の公開と配信のキャッシュ：写真を返す口が無い。
- 送る人のログイン：誰でも送れる仕様。上限で抑える。
- リトライ：Worker は D1 と R2 の呼び出しをやり直さない。
- 検証用の環境（staging）：ローカルの `wrangler dev`（ローカルの D1 と R2）とテストで確かめ、本番は1つだけ。
