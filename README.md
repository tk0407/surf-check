# 🏄 サーフチェック (Web)

エリア・日付・時間帯を選ぶと、関東のサーフポイントを波質スコアでランキング表示する静的Webアプリ。
データは [Open-Meteo](https://open-meteo.com)（Marine + Forecast API）をブラウザから直接取得。サーバー・APIキー不要。

公開: GitHub Pages（Settings → Pages → Deploy from a branch / `main` / root）。

## 構成

```
index.html      UI
style.css
scoring.js      採点ロジック
app.js          取得→平均→採点→描画
spots.json      スポットデータ
scoring.test.js テスト
```

## ローカルで動かす

```bash
python -m http.server 8000
# http://localhost:8000/
```

## テスト

```bash
node --test scoring.test.js
```

## スポット・採点ロジックの大元

このリポジトリは公開用。スポット定義(`spots.yaml`)と採点ロジック(Python版)の出所は
別プロジェクト `notion_tools` 側。スポットを更新する場合はそちらで `spots.json` を再生成し、
`spots.json`（および変更時は `scoring.js`）を本リポジトリへ反映する。

## データソース

Open-Meteo の GFS-Wave 系の数値予報モデル。実測値ではない点に注意。
