# ComfyUI-ProgressThrottleSafe

要件: メイングラボ・メインモニタ・タブアクティブのままで生成速度を落とさない。

実測で判明した三層の負荷すべてにソフトウェアのみで対処する構成。

| 負荷層 | 実測 | 対策 | 担当 |
|---|---|---|---|
| GPUコンポジット競合 | ≈4.6s | 生成中のCSSアニメーション(タブのスピナー等)を一時停止しコンポジタを止める | 本パッチ Quiet Mode |
| プレビュー配信 | ≈2.2s | ComfyUI設定 `Comfy.Execution.PreviewMethod` = `none`(設定UI)。または `--preview-method none` | 標準機能 |
| 進捗イベントのDOM更新 | ≈3s | progress/progress_state を統合バッチ化し最大2回/秒に間引き | 本パッチ Throttle |

## インストール

1. 旧パッチ(`comfyui-progress-throttle` 等)を削除
2. このフォルダを `ComfyUI/custom_nodes/` に配置
3. サーバー再起動 + ブラウザ Ctrl+F5
4. コンソールに `[progress-throttle-safe] active` と `[quiet-mode] registered` が出れば有効
5. 生成開始時に `[quiet-mode] on (css animations paused)`、終了時に `off` が出ることを確認

## 調整(ブラウザコンソール)

```js
// 進捗間引き
window.comfyProgressThrottleSafe.setProgressInterval(1000) // 既定500ms
window.comfyProgressThrottleSafe.getStats()  // received vs delivered で効果確認
window.comfyProgressThrottleSafe.resetStats()

// Quiet Mode
window.comfyExecutionQuietMode.disable() / .enable()
window.comfyExecutionQuietMode.setPauseCanvas(true) // 生成中キャンバス描画も停止(実験用)
```

## 計測プロトコル(各3回推奨)

1. パッチなし・タブアクティブ(基準の悪値: 25.3s相当)
2. パッチあり・タブアクティブ・5090描画・メインモニタ
3. タブ非アクティブ(理論下限: 15.6s相当)

2が3にどこまで迫るかが成果。差が残る場合は
`setProgressInterval(1000)` と `setPauseCanvas(true)` を追加して再計測。
それでも残る差はFirefoxコンポジタの常時負荷やOSスケジューリング由来で、
ページ内JSでは到達できない領域。

## 安全設計

- 完了イベント前に保留進捗を強制配送(完了後に古い進捗が復活しない)
- prompt_id別保持で並行ジョブに対応、再接続時は保留破棄
- 非表示タブでは素通し
- Quiet Modeはアニメーションの一時停止のみ(transitionは不変更、
  transitionend依存のコードを壊さない)。生成終了で即復帰
- requestAnimationFrame・実行系イベントには一切触れない
