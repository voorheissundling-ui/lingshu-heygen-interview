# Seedance 免费额度接入检查：Key 有效但模型未开通

- 日期：2026-10-24
- 状态：**只读验证完成；未成功创建任何视频任务；未产生费用**
- Key：仓库外文件已存在（不记录内容）
- 结论：Key 是**火山方舟 Ark** 的有效 API Key。控制台当前开通的 `Doubao-Seed3D-2.0`、`Hyper3D-Gen2`、`Hitem3D-2.0` 都是 **3D 资产生成模型，不是视频生成模型**；它们可用，但无法生成说话人物镜头。Seedance 视频模型（`doubao-seedance-2-0-260128` / `-fast`）仍为 `ModelNotOpen`，因此还不能使用 Seedance 视频免费额度。

## 1. 已验证

| 检查 | 请求 | 结果 |
| --- | --- | --- |
| Key 文件 | 本地读取 | 存在，单行，158 字符 |
| Ark 鉴权 | `GET /api/v3/contents/generations/tasks?page_size=1` | **200**，`{"total":0,"items":[]}` |
| Key 性质 | 同一个 Key 请求 Ark 数据面 | 有效；不是 fal.ai Key（fal 返回 401） |
| 视频任务历史 | 同上 | 0 条，账号未跑过 Seedance 任务 |
| 模型访问 | 见下表 | **2.0 / 2.0 fast 返回 `ModelNotOpen`；其余返回 `NotFound`** |
| 账号 | 错误响应 | `2130692501`（未开通模型） |

## 2. 模型探测结果

使用“非法时长 `duration=99`”做探测：如果模型可访问，应返回参数校验错误；实际全部在模型解析阶段返回 404，说明不是参数问题，而是没有模型权限。

最新一次探测（2026-10-24）：

| 模型 ID | 结果 |
| --- | --- |
| `doubao-seedance-2-0-260128` | 404 **`ModelNotOpen`**：账号未开通该模型 |
| `doubao-seedance-2-0-fast-260128` | 404 **`ModelNotOpen`**：账号未开通该模型 |
| `doubao-seedance-2-5-260928` | 404 `InvalidEndpointOrModel.NotFound` |
| `doubao-seedance-1-5-pro-251215` | 404 `InvalidEndpointOrModel.NotFound` |

官方错误文本（2.0 / 2.0 fast）：

```text
ModelNotOpen
Your account 2130692501 has not activated the model doubao-seedance-2-0-260128.
Please activate the model service in the Ark Console.
```

其余模型 ID：

```text
InvalidEndpointOrModel.NotFound
The model or endpoint <id> does not exist or you do not have access to it.
```

`ModelNotOpen` 比 `NotFound` 更明确：模型对当前账号是可见的，只差在控制台点击开通。

## 2.1 控制台已开通的 3 个模型：可用，但都是 3D 模型

用户截图显示已开通 `Doubao-Seed3D-2.0`、`Hyper3D-Gen2`、`Hitem3D-2.0`，各有免费 token 额度。用空 `content` 探测（不会创建任务）的结果：

| 控制台名称 | API 模型 ID | 探测结果 | 能力 |
| --- | --- | --- | --- |
| Doubao-Seed3D-2.0 | `doubao-seed3d-2-0-260328` | 400 `InvalidParameter: content field cannot be empty` | 图生 3D 资产 |
| Hyper3D-Gen2 | `hyper3d-gen2-260112` | 400 `InvalidParameter: content field cannot be empty` | 文/图生 3D 资产 |
| Hitem3D-2.0 | `hitem3d-2-0-251223` | 400 `InvalidParameter: content field cannot be empty` | 图生 3D 资产 |

判断依据：请求已经通过模型解析与鉴权，进入参数校验阶段；未出现 `ModelNotOpen` 或 `NotFound`，说明这 3 个模型对本账号**已开通、可调用**。空 `content` 是故意构造的非法参数，因此没有创建任务、没有消耗 token。

但这 3 个都是 **3D 资产生成**（输出 glb/obj 等模型文件），不是视频生成，不能直接产出人物说话镜头，也无法替代 Seedance 视频模型。要提升 3 个人物镜头画质，仍需在「开通管理」中开通 **Seedance 2.0 / 2.0 fast（视频生成）**。

## 3. 为什么需要先开通

火山方舟官方文档要求：

- 账户余额不少于 **200 元**，或已购买资源包，否则无法开通 Seedance 2.0 / 2.0 fast；
- 需要在控制台申请/开通对应模型（含 fast 档位权限）；
- 免费额度按模型发放，先在控制台「开通管理」确认剩余额度与有效期；
- 免费额度是否优先抵扣，取决于账号的“安心体验模式”或请求中的计费抵扣配置；不能只靠 Key 推断。

另：Seedance 2.0 fast 官方**不支持 1080p**，只支持 480p/720p；9:16 720p 输出为 **720×1280**，与现有 HeyGen 素材分辨率相同。若必须 1080p，需要使用标准 Seedance 2.0（或 2.5），但免费额度是否覆盖标准版需以控制台为准。

## 4. 需要用户完成的操作

1. 登录火山方舟控制台 →「开通管理」→ 搜索 **Seedance**（视频生成，不是 Seed3D/3D 生成）→ 开通 **Seedance 2.0 / 2.0 fast**，领取/确认免费额度；完成实名认证。当前已开通的 `Seed3D`、`Hyper3D`、`Hitem3D` 属于 3D 生成，不能用于本项目的人物视频镜头。
2. 如控制台要求创建推理接入点，请创建一个视频生成接入点，并复制 **Endpoint ID（`ep-...`）**。
3. 确认当前 API Key 属于同一账号/项目，且拥有该模型权限。
4. 把 Endpoint ID 放到仓库外文件（例如 `D:/secrets/seedance.endpoint.txt`），或直接在对话中提供（Endpoint ID 不是密钥）。
5. 完成后告知我；我会先用“非法参数探测”确认模型可访问，再提交 1 个镜头做质量验证，最后生成其余 2 个镜头。

## 5. 安全提醒

- 诊断过程中，一条命令把 Key 值输出到了本地会话日志，并且曾用该 Key 请求过 fal.ai（被 401 拒绝）。**建议在本次生成完成后立即在火山方舟控制台轮换/删除该 Key**，或现在轮换后提供新 Key。
- 后续脚本只从仓库外文件读取 Key，日志、证据、报告不记录 Key、签名 URL 或绝对路径。
- 未部署、未社媒发布、未产生任何视频任务或费用。

## 6. 参考

- [火山方舟：创建视频生成任务](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)
- [火山方舟：免费推理额度](https://docs.volcengine.com/docs/ark/free-inference-quota?lang=zh)
- [火山方舟：安心体验模式](https://docs.volcengine.com/docs/ark/free-tokens-only-mode?lang=zh)
- [Seedance 2.0 API 文档镜像](https://raw.githubusercontent.com/qianfree/team-api/b4c8cfd14a82db82f07793785423a46eba61de46/docs/%E5%8D%8F%E8%AE%AE%E6%96%87%E6%A1%A3/%E8%B1%86%E5%8C%85%E7%B3%BB%E5%88%97/seedance_2.0_API_%E5%88%9B%E5%BB%BA%E8%A7%86%E9%A2%91.md)
