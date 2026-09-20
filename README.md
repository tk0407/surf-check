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
app.js            取得→描画、タブ切替
spots.json        スポットデータ
scoring.test.js   テスト（採点）
forecast.test.js  テスト（時間帯平均・週間予報）
```

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
