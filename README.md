# 🏄 サーフチェック (Web)

エリア・日付・時間帯を選ぶと、関東のサーフポイントを波質スコアでランキング表示する静的Webアプリ。
「週間予報」タブでは、エリア内の各ポイントの7日分のスコアを朝・昼・夕で一覧でき、セルをタップすると詳細を表示する。
データは [Open-Meteo](https://open-meteo.com)（Marine + Forecast API）をブラウザから直接取得。サーバー・APIキー不要。

公開: GitHub Pages（Settings → Pages → Deploy from a branch / `main` / root）。

## 構成

```
index.html        UI
style.css
scoring.js        採点ロジック
forecast.js       時間帯平均・週間予報の組み立て（ランキングと共用）
share.js          表示ラベルの整形、共有テキスト・共有カード・共有URLの組み立て
app.js            取得→描画、タブ切替
spots.json        スポットデータ
scoring.test.js   テスト（採点）
forecast.test.js  テスト（時間帯平均・週間予報）
share.test.js     テスト（共有テキスト・共有URL・復元）
```

## 共有機能

ランキング結果の下に「LINEで送る」「画像で共有」の2つのボタンがある。LINEで送ると、上位3件のポイント名・点数・波と風を短いテキストにまとめ、結果を再現できるURL（`?region=&date=&slot=`）を添えてLINEのトーク選択画面を開く。「画像で共有」は同じ上位3件を1080×1080のカード画像としてcanvasに描画し、対応する端末では共有シートから、それ以外ではダウンロードで保存できる。共有URLを開くとエリア・日付・時間帯が自動で入り、そのままチェックが実行されて同じランキングが再現される。

## ローカルで動かす

```bash
python -m http.server 8000
# http://localhost:8000/
```

## テスト

```bash
node --test
```

## スポット・採点ロジックの大元

このリポジトリは公開用。スポット定義(`spots.yaml`)と採点ロジック(Python版)の出所は
別プロジェクト `notion_tools` 側。スポットを更新する場合はそちらで `spots.json` を再生成し、
`spots.json`（および変更時は `scoring.js`）を本リポジトリへ反映する。

## データソース

Open-Meteo の GFS-Wave 系の数値予報モデル。実測値ではない点に注意。
