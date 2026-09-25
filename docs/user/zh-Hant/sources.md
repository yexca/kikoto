# 來源
[English](../en/sources.md) · [簡體中文](../zh-Hans/sources.md) · [繁體中文](../zh-Hant/sources.md) · [日本語](../ja/sources.md) · [한국어](../ko/sources.md)

來源描述了文件的來源。

## Source Types

- 本機資料夾來源。
- Kikoeru 相容的遠端來源。
- 與舊版 Number178 相容的遠端來源僅適用於遷移的現有記錄。

## 當前行為

- 本機掃描偵測配置的資料根下支援的工作代碼資料夾。
- 遠端來源標籤瀏覽配置的來源，無需匯入每個結果。
- 工作詳細資訊使用後端聚合可用性檢查。
- 遠端同步將元資料和來源檔案樹匯入統一資料庫。
- 遠端快取在快取根目錄下具體化選定的遠端檔案。
- 遠端取得將選定的遠端檔案提升至本機資料樹。這
預設佈局為`/data/<source_code>/<code_prefix>_<code_group>/<work_code>`；
舊版 `<source_name>` 模板令牌仍被接受為別名
穩定的原始碼。
- 使用來源分離保存模板的相容來源聲明其 Fetch
帶有機器標記和多語言 `README.md` 的根。它的文件發生變化
不觸發本機資料夾觀察程序，因為 Fetch 註冊發布
直接地。没有匹配标记的预先存在的非空根显示为
阻止 Fetch 審查衝突，並且永遠不會自動採用。
- Markerless roots created by older Kikoto versions can be recognized from an
  active `managed_fetch` folder location for the same origin source or a
成功的 `remote_work_fetch` 運行，其成功計劃記錄相同
源根和目標根。 Kikoto 對照那些確切的根來驗證完整的根
歷史目標及其祖先，無需遍歷經過驗證的作品
子樹。允許常規根級別 `README.md`，但無法解釋的條目，
不存在目標的連結、重分析點和陳舊記錄保留根
在阻止審查中。辨識為唯讀；下一個 Fetch 寫入
標記並僅在尚不存在時添加多語言自述文件。
- 快取和本機刪除目標特定檔案位置，不統一工作。
混合選擇作為一個可恢復的工作流程提交；本地刪除
保留工作進度和聽力分數。
- 遠端來源清單和詳細資料頁面應保留來源範圍視圖；他們做
不取代統一的本地工作細節模型。
- 相容的遠端工作回應映射來源的目前 `price`。價值
不作為價格歷史記錄或被視為權威常規
價格。在演示模式下，遠端來源尋呼始終會新增 `$age:general$` 和
`$-price:1$` 到上游搜尋。細節和媒體訪問重複相同
使用確切的工作代碼過濾搜尋；返回的年齡和價格欄位不是
在當地解釋為政策輸入。
- `kikoeru_compatible_number178` 保留其用於遷移來源的適配器，但
被新來源和配置種子輸入拒絕。歷史的
`kikoeru_compilable_number178` 拼字會自動遷移。

## 可用性檢查

啟動和來源變更批次檢查首先驗證相關來源的運作狀況。這
探針偏好 `/api/health` 並回退到單一清單請求
不公開健康端點的相容源。

管理員可以透過維護手動運行相同的有界探測
`POST /api/file-sources/{id}/health-check`。回應報告健康狀況，檢查
時間和持續時間，而不返回配置的上游地址或原始地址
上游錯誤。

如果某個來源無法存取，Kikoto 會將該來源標記為對該批次不可用
並跳過每個工作的檢查。它並不將每個候選作品標記為缺失。

## 下載節奏

Remote downloads wait for configured delay and retry temporary errors with
退避。維護還配置有限制的每個檔案媒體下載大小；
預設值為 100 GB，可接受的範圍為 1–2048 GB。此限制適用於
即使來源未聲明，也可取得和播放快取實現
響應大小。遠端和 DLsite 覆蓋使用單獨的固定 20 MiB 限制。
DLsite 元資料同步也使用為提供者配置的基本延遲和退避
產品和封面請求。

來源回傳限流或暫時無法使用的回應時，Kikoto 會依其要求暫停對該來源的請求，
但暫停時間不會超過 Maintenance 中的最大退避。該來源排隊中的作業會等待暫停結束，
且不消耗重試次數；其他來源的作業照常執行。

取得計劃使用已經完整的持久性元資料和快取的來源
可用性。當請求的程式碼沒有DLsite快照或版本時
關係，準備在之前執行有界目標家庭同步
建立審查。排隊的 Fetch 重複使用期間接受的遠端樹
提交而不是立即再次請求同一棵樹。本地後
註冊成功，該 Fetch 提升的快取物件將被刪除；
未選擇的快取物件仍然可用。

## 相關文檔

- [工作細節](work-detail.md)
- [設定](settings.md)
- [來源存在](../../architecture/source-presence.md)
- [可靠性](../../operations/reliability.md)
