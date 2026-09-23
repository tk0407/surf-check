# 実況フィードバックと予報の補正 設計

作成日: 2026-09-23

## 目的

実際に海へ行った人が、その回の総合評価・波サイズ・風・写真を送れるようにする。送られた記録を、予報と実況の組（予実データ）として保存する。貯まった予実データから、次の2つを補正する。

1. ポイントごとの予報値の癖（「このポイントは予報より波が大きい」「風が強めに出る」）
2. ランキングの配点（「上位に出たのに実際は良くなかった」を減らす）

成功の条件は次の3つ。

- 1件を1分以内で送れる。最短で「総合をタップ → 送る」の2タップ。
- 数件で補正が効き始める。件数が少ないうちは、補正しない状態から大きく外れない。
- 補正の前後で予実の誤差が縮んだことを、数字で確かめられる。

## スコープ

**含む**

- ランキングの各カードに置く「行ってきた」ボタンと、入力パネル
- 写真1枚（任意）。写真から撮影位置・撮影時刻が読めたときの活用
- Cloudflare Worker（API）、D1（記録）、R2（写真）
- 補正の計算（ポイントごとの波サイズ倍率・風速のずれ、全体のランキング配点）
- 補正をランキング・週間予報・共有テキストと共有画像にかけること、カードの「実況補正」表示
- 補正の効果を測る検証値（leave-one-out）
- README の更新と公開の手順

**含まない**

- 記録や写真を見る画面（写真は Cloudflare の管理画面で見る）
- 記録の編集・削除の画面（送り直しで上書きする。削除はコマンド）
- 潮の入力・記録・学習
- 風向きの補正（的中率を出すだけ）
- 人ごとの感じ方の差の補正（端末IDは保存しておく）
- 風速を時間帯ごとに分けた補正
- 古い記録の重みを下げること
- Python版（`notion_tools` の `scoring.py`）への補正の反映
- ボット判定（Cloudflare Turnstile）
- 撮影位置を使った `spots.json` の座標の検証（データだけ貯める）
- 電波が無いときに端末へ保留しておき、後で自動で送り直すこと

## 全体の制約

- サイトは今のまま GitHub Pages に置く。ビルド工程を増やさない。サイト側に新しいパッケージを入れない。外部スクリプトを読み込まない。
- Worker も依存パッケージを持たない。`wrangler` は開発ツールとして `npx wrangler@4` で使う。`package.json` は作らない。**初めて `npx wrangler` を実行する前に、ユーザーの承認を得る。**
- `scoring.js` は変更しない。Python版が正本のしきい値を保つため。補正は `calibration.js` の上乗せ層で行う。
- 補正の計算には、必ず補正前の生の予報値を使う。補正が自分の出力を学び直して偏らないようにするため。
- 補正が無いとき（取得の失敗を含む）のランキング・週間予報・共有の表示と点数は、今とまったく同じになること。
- 本番コードにテスト用の分岐を入れない。テストは `node --test` だけで動かす。
- `app.js` の `FEEDBACK_API` が空文字のときは、補正を取りに行かず、「行ってきた」ボタンも出さない。Worker を公開する前にマージしても、サイトは今と同じに動く。
- 画面に出す文字列は `escapeHtml` を通す。
- スマホ幅 375px で、ページも入力パネルも横スクロールしない。
- `index.html` のアセット参照の `?v=` の日付を上げる。
- 秘密情報（`IP_SALT`、Cloudflare の認証情報）は、リポジトリにも markdown にも書かない。
- コミットメッセージの末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` を付ける。

## 全体の構成

```
GitHub Pages（今のサイト）
 ├─ 起動時に GET /calibration を読む（誰でも読める。中身は補正の数値だけ）
 │    → 予報値とスコアに補正をかけて表示。読めなければ今までどおり
 └─ カードの「行ってきた」 → 入力パネル → POST /feedback

Cloudflare Worker（worker/）
 ├─ D1: feedback（記録）, submissions（送信の回数制限用）
 ├─ R2: 写真（非公開）
 └─ GET /calibration は D1 の記録からその都度計算する
```

## UI / 導線

### ボタン

- ランキングの各カードの一番下（ライブカメラの行の下）に `<button type="button" class="feedback-open">行ってきた</button>` を置く。誰でも押せる。
- この端末で、そのポイントについて「パネルの初期値の日付・時間帯」で送ったことがあれば、ラベルを「送り直す」にする。送信済みの組は、端末の `localStorage` に `スポット名|日付|時間帯` の集合として持つ。
- 週間予報タブには置かない。

### 入力パネル

`<dialog>` を画面の下から出す。

```
一宮  9/23（火）                 [朝][■昼][夕]
─────────────────────────────
総合    [1ダメ][2イマイチ][3ふつう][4良い][5最高]   ← 必須・初期値なし
波      [フラット][ヒザ][コシ〜ハラ][■ムネ〜カタ][カタ〜アタマ]
        [アタマ〜オーバー][オーバーヘッド][ダブル+]
風向き  [■オフ][サイド][オン]
風の強さ [無風][■弱い][強い]
写真    [ 写真を追加 ]（任意）
名前    [          ]（任意・初回だけ表示）
─────────────────────────────
                     [ 送る ]
■ = 初期値
```

- **日付と時間帯**
  - 初期値はカードの日付と時間帯。ただし、その時間帯がまだ始まっていなければ、すでに始まっている直近の時間帯にする。7時前なら前日の夕方になる。
  - 時間帯の開始は、朝が7:00、昼が12:00、夕が16:00（`TIME_SLOTS` の開始時刻）。
  - 日付は `<input type="date">` で選ぶ。選べるのは「今日から30日前」〜「今日」（日本時間）。今日を選んだときは、まだ始まっていない時間帯を押せないようにする。
  - 日付か時間帯を変えたら、そのポイントの予報を取り直す。波・風向き・風の強さは新しい初期値に戻す。総合は残す。
- **波・風向き・風の強さの初期値**：カードに出ていた値、つまり補正後の予報から作る。触らずに送れば「表示どおりだった」という意味になる。記録に入れる予報値は、補正前の値（`rawData`）にする。
- **総合**：初期値なし。選ぶまで「送る」は押せない。
- **名前**：まだ一度も送信に成功していない端末でだけ表示する。20文字まで。空でもよい。入力した名前は `localStorage` に保存し、以後の送信にも付ける。
- **写真**：`<input type="file" accept="image/*">` で選ぶ。選ぶと縮小版が表示され、取り消しボタンも出る。
- **写真から撮影時刻が読めたとき**：その日付と時間帯をパネルに入れる。ただし、次のどれかに当たるときは入れない。
  - パネルで日付か時間帯をすでに手で変えている
  - 撮影日が選べる範囲の外にある
  - 決まった時間帯が、今日のまだ始まっていない時間帯になる
- **写真から撮影位置が読めたとき**：全ポイントの中で撮影位置に一番近いポイントを探す。それが選択中のポイントと違い、かつ選択中のポイントまでが1.0kmを超えるときは、次の行を出す。

  ```
  写真は ◯◯ 付近（約 X.Xkm）で撮られています  [◯◯に変える]
  ```

  「変える」を押すと、パネルのポイントを切り替えて予報を取り直す。提案を無視して、そのまま送ってもよい。
- **送信に成功したとき**：「送りました」と短く出してパネルを閉じる。カードのボタンは「送り直す」になる。

### 区分の定義

**風向き**
- `diff` は、風向とオフショアの向き（`(bearing + 180) % 360`）との角度差。
- 区分は今の風ラベル（`windConditionLabel`）をまとめたもの。

| 区分 | 条件 | 今のラベル |
|---|---|---|
| オフ（`off`） | `diff ≤ 75` | オフショア・サイドオフ |
| サイド（`side`） | `75 < diff ≤ 105` | サイド |
| オン（`on`） | `diff > 105` | サイドオン・オンショア |

**風の強さ**
- しきい値は `windSpeedScore` の区切りに合わせる。

| 区分 | 条件 | 代表値 |
|---|---|---|
| 無風（`calm`） | `v ≤ 2` | 1.0 m/s |
| 弱い（`light`） | `2 < v ≤ 5` | 3.5 m/s |
| 強い（`strong`） | `v > 5` | 7.0 m/s |

**波の帯**
- 区切りは `waveSizeLabel` と同じ。範囲は「以上〜未満」（0.3 ちょうどはヒザ）。

| 番号 | ラベル | 範囲（m） | 中央（m） |
|---|---|---|---|
| 0 | フラット | 0 〜 0.3 | 0.15 |
| 1 | ヒザ | 0.3 〜 0.5 | 0.4 |
| 2 | コシ〜ハラ | 0.5 〜 0.8 | 0.65 |
| 3 | ムネ〜カタ | 0.8 〜 1.1 | 0.95 |
| 4 | カタ〜アタマ | 1.1 〜 1.5 | 1.3 |
| 5 | アタマ〜オーバー | 1.5 〜 2.0 | 1.75 |
| 6 | オーバーヘッド | 2.0 〜 2.5 | 2.25 |
| 7 | ダブル+ | 2.5 〜 | 3.0 |

### 写真の扱い

- **撮影位置と撮影時刻の読み取り**：縮小する前の元のファイルから読む。
  - 読むのは JPEG の EXIF だけ。撮影時刻は `DateTimeOriginal`、撮影位置は GPS の緯度・経度。HEIC など JPEG 以外のファイルは読まない。
  - 撮影時刻は日本時間として扱い、`YYYY-MM-DDTHH:MM` の形にする。
  - 読めなければ `null` にする。エラーは出さない。
- **撮影時刻から時間帯を決める規則**：朝・昼・夕のうち、撮影時刻に一番近い時間帯を選ぶ。
  - 時間帯の範囲は、朝が7〜10時、昼が12〜15時、夕が16〜19時。範囲の中なら距離は0。
  - 2つの時間帯から同じ距離のときは、早い方を選ぶ。
- **縮小**：`<canvas>` で長辺1600pxに縮め、JPEG の品質0.8で書き出す。
  - 1.5MB を超えたら、品質0.6で書き直す。それでも超えたら「写真が大きすぎます」と出す。
  - 書き出した写真には EXIF が残らない。撮影位置は記録の項目として別に持つ。
- iPhone の Safari や Android の Chrome は、ページに写真を渡す時点で位置情報を消すことが多い。撮影位置は「読めたら使う」扱いにし、公開後に実機で確かめる（確認方法を参照）。

## 記録の中身（D1）

`worker/schema.sql`

```sql
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  spot TEXT NOT NULL,
  date TEXT NOT NULL,            -- YYYY-MM-DD（日本時間）
  slot TEXT NOT NULL,            -- morning | afternoon | evening
  bearing REAL NOT NULL,         -- 送った当時のポイントの向き
  fc_wave_height REAL NOT NULL,  -- ここから5列は補正前の予報
  fc_wind_dir REAL NOT NULL,
  fc_wind_speed REAL NOT NULL,
  fc_swell_dir REAL NOT NULL,
  fc_swell_period REAL NOT NULL,
  rating INTEGER NOT NULL,       -- 1..5
  wave_band INTEGER NOT NULL,    -- 0..7
  wind_side TEXT NOT NULL,       -- off | side | on
  wind_strength TEXT NOT NULL,   -- calm | light | strong
  photo_key TEXT,
  photo_lat REAL,
  photo_lon REAL,
  photo_taken_at TEXT,           -- YYYY-MM-DDTHH:MM（日本時間）
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,      -- ISO 8601（UTC）
  updated_at TEXT NOT NULL,
  UNIQUE (device_id, spot, date, slot)
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  day TEXT NOT NULL              -- YYYY-MM-DD（日本時間）
);
CREATE INDEX IF NOT EXISTS submissions_day ON submissions (day);
```

- **1件の記録**：1件が1回分のセッションになる。同じ端末・ポイント・日付・時間帯で送り直すと上書きされる。
  - `created_at` は最初に送った時刻のまま残し、`updated_at` だけを更新する。
  - 写真を付けずに送り直したときは、前の `photo_key` と写真の位置・時刻を残す。
- **`submissions`**：送信が成功するたびに1行足す。上書きも1回と数える。回数の上限の判定にだけ使う。3日より古い行は、送信のたびに消す。
- **ポイントの持ち方**：名前で持つ。名前を変えたときは、記録側もSQLで書き換える（README に手順を書く）。書き換えなければ、そのポイントに補正がかからなくなるだけで、エラーにはならない。
- **端末ID**：`crypto.randomUUID()` で作り、`localStorage` に保存する。本人確認には使わない。記録を区別するためだけのラベル。

## API（Worker）

### `POST /feedback`

`multipart/form-data` で受け取る。

- `record`：次の形の JSON 文字列
- `photo`：JPEG（任意）

```json
{
  "device_id": "2f1c…（UUID v4）",
  "name": "",
  "spot": "一宮",
  "date": "2026-09-23",
  "slot": "morning",
  "bearing": 100,
  "forecast": { "wave_height": 0.9, "wind_dir": 270, "wind_speed": 3.2, "swell_dir": 95, "swell_period": 9.5 },
  "observed": { "rating": 4, "wave_band": 3, "wind_side": "off", "wind_strength": "light" },
  "photo_meta": { "lat": 35.34, "lon": 140.39, "taken_at": "2026-09-23T07:42" }
}
```

`photo_meta` は `null` でもよい。`lat` / `lon` / `taken_at` は、それぞれ `null` でもよい。

**入力チェック**
- ブラウザと Worker は、`feedback.js` の `validateRecord` という同じ関数を使う。
- 違反があれば `400` を返し、どの項目がどう違うかを日本語で返す。

| 項目 | 条件 |
|---|---|
| `device_id` | UUID v4 の形 |
| `name` | 前後の空白を除いて20文字以内。制御文字を含まない |
| `spot` | 1〜40文字 |
| `date` | 実在する `YYYY-MM-DD`。今日（日本時間）から30日前〜今日 |
| `slot` | `morning` / `afternoon` / `evening` のどれか。今日なら、その時間帯の開始時刻を過ぎている |
| `bearing`、`forecast.wind_dir`、`forecast.swell_dir` | 0〜360 |
| `forecast.wave_height` | 0〜20 |
| `forecast.wind_speed` | 0〜60 |
| `forecast.swell_period` | 0〜30 |
| `observed.rating` | 整数 1〜5 |
| `observed.wave_band` | 整数 0〜7 |
| `observed.wind_side` | `off` / `side` / `on` のどれか |
| `observed.wind_strength` | `calm` / `light` / `strong` のどれか |
| `photo_meta.lat` / `lon` | −90〜90 / −180〜180 |
| `photo_meta.taken_at` | `YYYY-MM-DDTHH:MM` |

**写真の受け付け**
- 先頭のバイトが `FF D8 FF`（JPEG）のものだけ受け付ける。違えば `415` を返す。
- 1,572,864バイト（1.5MB）までにする。超えたら `413` を返す。
- リクエスト全体は2MBまでにする。超えたら `413` を返す。
- R2 には `photos/<UUID>.jpg` という推測できない名前で保存する。

**回数の上限**
- 日本時間の1日ごとに、`submissions` の行数で判定する。超えたら `429` を返し、`{"error": "...", "limit": "device" | "ip" | "total"}` の形でどの上限かを知らせる。

| 単位 | 上限 |
|---|---|
| 1端末 | 1日20件 |
| 同じ回線（`ip_hash`） | 1日30件 |
| 全体 | 1日100件 |

- `ip_hash` は、`CF-Connecting-IP` に Worker の秘密の値 `IP_SALT` を混ぜた SHA-256（16進）。IP アドレスそのものは保存しない。

**保存の順序**
1. 写真があれば、先に R2 へ保存する。
2. 記録を保存する（同じ組があれば上書き）。
3. 記録の保存に失敗したら、1で保存した写真を消して `500` を返す。
4. 上書きで写真を差し替えたときは、記録を保存できてから古い写真を消す。

**成功時の応答**：`200 {"ok": true, "id": 123, "updated": true | false}`。`id` は記録の番号、`updated` は上書きだったかどうか。

### `GET /calibration`

- 誰でも読める。補正の数値だけを返す。記録・名前・写真・写真の位置は含めない。
- `Cache-Control: public, max-age=300` を付ける。
- `?metrics=1` を付けたときだけ `metrics` を足す。

```json
{
  "version": 1,
  "generated_at": "2026-09-23T03:00:00.000Z",
  "n": 42,
  "spots": {
    "一宮": { "n": 7, "wave_factor": 1.18, "wind_offset": 0.6, "wind_side_hit": 0.71 }
  },
  "weights": { "wind_direction": 20, "wind_speed": 10, "swell_direction": 20, "swell_period": 20, "wave_height": 15 },
  "weights_learned": false,
  "metrics": {
    "n": 42,
    "wave_band_mae": { "raw": 0.81, "calibrated": 0.52 },
    "wind_strength_hit": { "raw": 0.55, "calibrated": 0.66 },
    "wind_side_hit": 0.71,
    "rating_concordance": { "default": 0.61, "calibrated": 0.68 }
  }
}
```

- 数値は小数第3位で丸める。
- 記録が0件のときは、`n: 0`、`spots: {}`、今の配点、`weights_learned: false` を返す。

### CORS

- `POST /feedback` と、その事前確認（`OPTIONS`）は、`ALLOWED_ORIGINS`（`wrangler.toml` の変数、カンマ区切り）に一致するときだけ `Access-Control-Allow-Origin` を返す。`Origin` が無い、または一致しない `POST` には `403` を返す。
- `ALLOWED_ORIGINS` は、本番ではサイトのオリジンだけにする。ローカル開発では `worker/.dev.vars` で `http://localhost:8000` を足し、開発用の `IP_SALT` もそこに置く。`.dev.vars` は `.gitignore` に入れる。
- `GET /calibration` は公開情報なので `Access-Control-Allow-Origin: *` にする。

## 補正のアルゴリズム（`calibration.js`）

`Calibration.compute(records)` は D1 の `feedback` の行の配列を受け取り、`{version: 1, n, spots, weights, weights_learned}` を返す。`generated_at` は Worker が足す。計算に使う列は `device_id`、`spot`、`bearing`、`fc_` で始まる5列、`rating`、`wave_band`、`wind_side`、`wind_strength`。

定数（調整できる値）

| 名前 | 値 | 意味 |
|---|---|---|
| `PRIOR_K` | 3 | 「補正なし」側へ寄せる強さ（件数換算） |
| `DEVICE_CAP_SPOT` | 5 | 1台がそのポイントの補正に効く最大件数 |
| `DEVICE_CAP_WEIGHTS` | 30 | 1台が配点の学習に効く最大件数 |
| `WAVE_LOG_CLAMP` | ln 2 | 波の1件あたりの誤差の上限（0.5倍〜2倍） |
| `WIND_CLAMP` | 4 | 風速の1件あたりの誤差の上限（m/s） |
| `RIDGE_LAMBDA` | 5 | 配点を今の値にとどめる強さ |
| `MIN_WEIGHT_RECORDS` | 15 | 配点を学び始める件数 |
| `WEIGHT_BOUNDS` | 0.5〜2 | 今の配点に対する各項目の倍率の範囲 |

### ① 波サイズの倍率（ポイントごと）

1件ごとの誤差 `e` を出す。`h` は補正前の予報波高、`b` は選ばれた帯の番号。

- `h ≤ 0` の記録は、この計算に使わない。
- `h` が帯 `b` の範囲に入っていれば、`e = 0`。
- 入っていなければ、`e = clamp(ln(中央[b] / h), −ln 2, ln 2)`。

ポイントごとに次のように合わせる。

1. 端末 `d` ごとに、平均 `m_d` と件数 `n_d` を出す。
2. 重みを `w_d = min(n_d, 5)` とする。
3. `E = Σ w_d·m_d / (Σ w_d + 3)` を計算し、`wave_factor = exp(E)` とする。

例えば同じ端末の記録が1件なら誤差の1/4、3件なら1/2だけ効く。1件あたりの誤差に上限があるので、`wave_factor` は必ず0.5〜2の間に入る。

### ② 風速のずれ（ポイントごと）

- 1件ごとの誤差：予報の風速 `v` が選ばれた強さの範囲に入っていれば `e = 0`。入っていなければ `e = clamp(代表値 − v, −4, 4)`。
- 合わせ方は①と同じ。結果を `wind_offset`（m/s）とする。
- かけ方：`v' = max(0, v + wind_offset)`。

### ③ 風向きの的中率（ポイントごと）

- 予報の区分と選ばれた区分が一致した割合を `wind_side_hit` とする。
- 補正はしない。

### ④ ランキングの配点（全ポイント共通）

1. **各記録の特徴量を作る**
   - 補正前の予報に、全記録から出した①②をかける。
   - `Scoring` の各項目の関数で点数を出し、満点で割る。これを `x_i`（0〜1）とする。
   - 項目は5つ：風向き（満点20）、風速（10）、うねりの向き（20）、うねりの周期（20）、波高（15）。今の配点を `w⁰ = (20, 10, 20, 20, 15)` とする。
2. **各記録の重みを決める**：`ω_j = min(1, 30 / N_d)`。`N_d` はその端末の全記録数。
3. **学習しない条件**：記録が15件未満なら、今の配点を使い、`weights_learned: false` にする。
4. **全体の傾きを出す**
   - `t_j = Σ w⁰_i·x_ij`（今の配点での合計点）とする。
   - 評価 `r_j` を `t_j` に重み付きで単回帰し、傾き `γ` を出す。
   - `γ ≤ 0` のとき、または `t` の分散が0のときは、今の配点を使う。
5. **配点を学ぶ**
   - 重み付き平均を引いて中心化した `X`（n×5）と `r` を使い、次の式を解く。

     `(Xᵀ Ω X + λI) θ = Xᵀ Ω r + λ γ w⁰`（λ = 5）

     5×5 の連立方程式なので、部分ピボット付きのガウス消去で解く。
   - 項目ごとに `w_i = θ_i / γ` とし、`[0.5·w⁰_i, 2·w⁰_i]` に収める。
   - 最後に、合計が85になるように全体を拡大・縮小する。上下限はこの拡大・縮小の前に当てる。そのため、拡大・縮小の後はわずかに範囲を外れることがある。
   - `weights_learned: true` にする。

### サイトでのかけ方

- `Calibration.adjust(data, spotName, cal)`
  - `wave_height` に `wave_factor` をかけ、`wind_speed` に `wind_offset` を足した新しい `data` を返す。
  - 入力の `data` は書き換えない。
  - `cal` が `null` のとき、またはポイントが載っていないときは、元と同じ値を返す。
- `Calibration.score(data, bearing, cal)`
  - `Scoring.scoreSpot(data, bearing)` と同じ形を返す。
  - 各項目の点数は `scoreSpot` のまま。`total` だけを `round(Σ w_i · 項目点 / 満点_i)` に置き換える。
  - 配点が今の値なら `total` は今と一致する。
- **ランキング**：`rankSpot` は補正後の `data` を返し、採点と表示に使う。フィードバック用に、補正前の値を `rawData` として一緒に返す。共有テキストと共有画像は `data` と `scores` を使うので、自動で補正後の値になる。
- **週間予報**：`Forecast.weeklyForecast` に、補正と採点を行う関数を任意で渡せるようにする。渡さなければ今と同じ動きになる。
- **カードの表示**：そのポイントに記録が1件以上あるときだけ、理由の行に小さな表示を出す。

  ```
  実況補正 7件（波×1.2・風+0.6m/s）
  ```

  - 波の倍率は小数第1位で表示する。
  - 風の部分は `|wind_offset| ≥ 0.5` のときだけ付ける。風速は小数第1位で、符号を付けて表示する。
- **補正の読み込み**
  - 起動時に取得を始め、最大2秒待つ。間に合わなければ補正なしで描画する。遅れて届いた補正は、次の検索から使う。
  - `Calibration.validate(json)` が次をすべて満たすか確かめ、満たさなければ補正なしにする。
    - `version === 1`
    - 各値が有限の数
    - `wave_factor` が0.5〜2
    - `wind_offset` が−4〜4
    - 配点の5項目がそろい、それぞれ0より大きく、合計と85の差が0.1以内

### 効果の測り方（`Calibration.metrics(records)`）

- **方法**：記録を1件ずつ抜き、残りの記録で補正を計算する。その補正で、抜いた1件を予測する（leave-one-out）。
- **計算量**：記録数の2乗に比例する。数百件なら問題ない。1000件を超えたら、定期実行に移す（今回は対象外）。

| 指標 | 中身 |
|---|---|
| `wave_band_mae` | 予報の帯と選ばれた帯のずれ（段数）の平均。`raw` は補正前、`calibrated` は補正後 |
| `wind_strength_hit` | 風の強さの区分が一致した割合。補正前と補正後 |
| `wind_side_hit` | 風向きの区分が一致した割合 |
| `rating_concordance` | 評価が違う2件の組のうち、評価の高い方に高い点を付けられた割合。点が同じなら0.5と数える。`default` は今の本番（補正なし・今の配点）、`calibrated` は①②④をすべてかけたもの |

## モジュール構成

| ファイル | 役割 |
|---|---|
| `calibration.js`（新規） | UMD（`root.Calibration`、`require("./scoring.js")`）。帯・風の区分、1件ごとの誤差、`compute(records)`、`metrics(records)`、`adjust`、`score`、`validate`、`summaryLabel(spotName, cal)`。サイト・Worker・テストで同じものを使う |
| `feedback.js`（新規） | UMD（`root.Feedback`、`require("./scoring.js")`, `require("./calibration.js")`）。初期値の作成（`defaultSession`、`slotForTime`、`initialObserved`）、`buildRecord`、`validateRecord`、`readExif(ArrayBuffer)`、`distanceKm`、`suggestSpot`。DOM には触らない |
| `feedback-panel.js`（新規） | ブラウザ専用。入力パネルの描画と操作、写真の縮小、送信。必要なもの（ポイント一覧、予報の取得関数、補正、API のURL）は引数で受け取り、`app.js` のグローバルには依存しない |
| `app.js` | 補正の読み込み、`rankSpot` と週間予報への補正のかけ方、カードの「行ってきた」ボタンと「実況補正」表示、パネルの呼び出し。`FEEDBACK_API` 定数を置く |
| `forecast.js` | `weeklyForecast` に、補正と採点を行う関数を任意で受け取る引数を足す |
| `index.html` | 新しい3つのスクリプトを読み込む。`?v=` を上げる |
| `style.css` | パネル、チップ、「行ってきた」ボタン、「実況補正」表示の見た目 |
| `worker/index.mjs`（新規） | Worker 本体。`POST /feedback`、`GET /calibration`、CORS、回数の上限 |
| `worker/schema.sql`（新規） | D1 のテーブル定義 |
| `worker/wrangler.toml`（新規） | Worker 名、D1・R2 の紐づけ、`ALLOWED_ORIGINS` |
| `.gitignore`（新規） | `worker/.dev.vars` と `worker/.wrangler/` を除外する |
| `worker/d1-sqlite.mjs`（新規・テスト専用） | Node 内蔵の `node:sqlite` を D1 と同じ呼び方（`prepare().bind().first()/all()/run()`）で使うための薄い変換 |
| `worker/worker.test.mjs`（新規） | Worker のテスト |
| `calibration.test.js`、`feedback.test.js`（新規） | テスト |
| `README.md` | 構成、フィードバック機能、公開の手順、記録の消し方と名前の書き換え方 |

`scoring.js` は変更しない。

## エラー処理

| 場面 | 振る舞い |
|---|---|
| 補正の取得の失敗・2秒の時間切れ・形の不正 | 補正なしで今までどおり表示する。メッセージは出さない |
| パネルでの予報の取り直しの失敗 | 「予報を取得できませんでした」と出し、「送る」を押せないようにする |
| 写真の読み込みや縮小の失敗 | 「写真を読み込めませんでした」と出す。写真なしで送れる |
| 撮影位置・撮影時刻が読めない | 何も出さない |
| 送信で `400` | サーバーが返したメッセージを出す。入力と写真は残す |
| 送信で `413` / `415` | 「写真を送れませんでした（大きさ・形式）」と出す。写真を外せば送れる |
| 送信で `429` | 「今日はこれ以上送れません」と出す |
| 送信で通信失敗・`5xx` | 「送れませんでした。もう一度送ってください」と出す。入力と写真は残す |
| Worker で記録の保存に失敗 | 先に保存した写真を消し、`500` を返す |

## テスト

`node --test` で全部動かす。依存パッケージは追加しない。作りものに置き換えるのは R2 だけにする（`Map` に入れる `put` / `get` / `delete`）。

**`calibration.test.js`**
- 帯と区分：帯の番号と区切りの境目（0.3、0.5、0.8、1.1、1.5、2.0、2.5 ちょうど）。風向きは 75 / 105 ちょうど、風の強さは 2 / 5 ちょうど
- 1件ごとの誤差：
  - 帯の中なら0、帯の外なら中央との比の対数
  - ln 2 での打ち切り。予報0の記録は除く
  - 風速の打ち切り（±4）
- ポイントごとの合わせ方：
  - K=3 で寄せた値。1件のとき、同じ端末3件のとき、2台のとき
  - 1台が5件を超えても、重みが5件分で止まる
- 配点：
  - 15件未満では今の配点のまま
  - 今の配点どおりの関係で作った記録からは、今の配点に近い値が返る
  - 特定の項目を強めて作った記録からは、その項目の配点が上がる
  - 上下限で止まる。合計は85
  - 30件を超えた端末の重みが下がる
  - 評価が全部同じ、または傾きが0以下のときは今の配点
- `adjust` / `score`：
  - 補正なしで今の `scoreSpot` と完全に一致する
  - 入力を書き換えない。知らないポイントは素通しする
- `validate`：正しい形、`version` 違い、範囲外の値、`NaN`、欠けた項目
- `metrics`：ポイントに偏りを入れた作りものの記録で、`wave_band_mae` の `calibrated` が `raw` より小さくなる。記録が1件以下のとき
- `summaryLabel`：記録が無いポイントと補正が無いときは空。風の部分の境目（`wind_offset` が ±0.5 ちょうどと、その内側）

**`feedback.test.js`**
- `defaultSession`：
  - 時間帯の開始の境目（7:00、12:00、16:00 ちょうどと、その1分前）
  - 7時前は前日の夕方
  - カードの時間帯がすでに始まっていれば、そのまま使う
- `slotForTime`：時間帯の範囲の中、範囲の間、同じ距離のときは早い方
- `initialObserved`：補正後の予報から、帯・風向き・風の強さの初期値ができる
- `validateRecord`：表の各項目の正常値と、境目の外側の値。未来の日付、今日のまだ始まっていない時間帯、31日前
- `readExif`：テストの中でバイト列から組み立てた JPEG を使う
  - 撮影位置と撮影時刻があるもの
  - EXIF が無いもの
  - GPS だけ無いもの
  - 南緯・西経（参照が `S` / `W`）
  - 途中で切れた壊れたもの（`null` を返し、例外を投げない）
  - JPEG でないもの
- `suggestSpot`：1.0km の境目、一番近いのが選択中のポイントのとき、撮影位置が無いとき

**`worker/worker.test.mjs`**
- テーブル定義は `worker/schema.sql` を `node:sqlite` にそのまま流す。
- 送信の成功：記録が1行でき、写真が R2 に入る
- 同じ組での送り直し：上書きになり、`created_at` は変わらない
  - 写真なしで送り直すと、前の写真が残る
  - 写真ありで送り直すと、古い写真が消える
- 入力チェックの違反：`400` と、項目名を含むメッセージ
- JPEG でない写真は `415`、大きすぎる写真は `413`
- 回数の上限：端末20件、回線30件、全体100件のそれぞれで、21 / 31 / 101 件目が `429` になる。日付が変われば数え直す
- CORS：許可したオリジンの `OPTIONS` と `POST` は通る。許可していないオリジンの `POST` は `403` になる
- 記録の保存が失敗したとき（D1 の代わりに、失敗するものを渡す）、R2 に写真が残らない
- `GET /calibration`：
  - 0件のときの形
  - 記録があるときに、補正の数値が `calibration.js` の `compute` と一致する
  - `metrics=1` のときだけ `metrics` が付く
  - 記録・名前・写真の位置が含まれない

## 公開の手順

**ユーザーが行う**
1. Cloudflare のアカウントを作る。R2 を有効にするとき、支払い方法の登録を求められる場合がある（無料枠の中なら請求はない）。
2. `npx wrangler@4 login` を実行する（ブラウザでのログイン）。

**Claude が行う（初めて `npx wrangler` を使う前に承認を得る）**
1. `npx wrangler@4 d1 create surf-check-feedback` を実行し、出力された ID を `wrangler.toml` に書く。
2. `npx wrangler@4 r2 bucket create surf-check-photos` を実行する。
3. `npx wrangler@4 d1 execute surf-check-feedback --remote --file worker/schema.sql` でテーブルを作る。
4. `npx wrangler@4 secret put IP_SALT` を実行する。値はその場でランダムに作り、どこにも書き残さない。
5. `npx wrangler@4 deploy` で公開する。
6. 公開された URL を `app.js` の `FEEDBACK_API` に入れる。
7. README に次の手順を書く。
   - 記録の消し方：`DELETE FROM feedback WHERE device_id = ?` や、日付の範囲で消す例
   - ポイント名の書き換え方：`UPDATE feedback SET spot = ? WHERE spot = ?`

## 確認方法

1. `node --test` がすべて通る。
2. 補正が無い状態の表示と点数が、今の main と同じことを確かめる。`FEEDBACK_API` に届かないとき、または補正が0件のとき、同じ地域・日付・時間帯のランキングの順位と点数を main と比べる。
3. ローカルで一通り動かす。
   - `npx wrangler@4 dev`（ローカルの D1 / R2）と `python3 -m http.server 8000` を立てる。
   - パソコンのブラウザから写真付きで送る。
   - D1 の行と R2 の写真を確かめる。
   - `/calibration?metrics=1` の値が変わることを確かめる。
4. 375px の幅で、パネルが横スクロールせず、最短2タップで送れることを確かめる。
5. 公開後、ユーザーのスマホで写真付きの送信を1回してもらい、次を確かめる。
   - D1 の `photo_lat` / `photo_lon` / `photo_taken_at` が入ったかどうか（入らなければ README に「端末が位置情報を消すため使えない」と書く）
   - R2 の写真に EXIF が残っていないこと
