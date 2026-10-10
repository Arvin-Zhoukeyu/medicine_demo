# 智能药盒手机网页

本项目是与《智能药盒 产品说明与 PRD》对应的手机尺寸网页。包含创建计划、整理文字或照片中的已有安排、核对字段、绑定 1 至 3 号药格、今日任务、开盒与服用确认分离、待核实、记录时间线和到期归档。处方照片字段完整时自动生成计划草稿，用户对照原照片确认后才启用；说明书只提供识别文字，不会据通用用法直接生成个人计划。右下角“用药助手”可查询当前计划、预置的有来源药品资料，也可对照用户上传并核对过的说明书文字回答。

环境和运行步骤见 [requirements.md](requirements.md)。主要文件：`server.py` 为本地网页及百炼接口服务，`web/` 为页面，`test_api_key.py` 为独立密钥检测脚本，`tests/` 为自动化测试。

运行测试：

```powershell
node --test tests/*.test.js
python -m unittest discover -s tests -p "test_*.py"
```

测试场景与操作步骤见 [TEST_CASES.md](TEST_CASES.md)。
