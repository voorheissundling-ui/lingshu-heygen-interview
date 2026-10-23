export const BENCHMARK_ANALYSIS_CONTRACT = `
- 开场钩子就是第一个分镜，详细分析写入该分镜已有字段，不另建钩子对象或重复章节；第一个分镜 narrativeRole=hook。
对标分析结构化合同（新增字段的键与枚举使用以下英文，其余说明用中文）：
- 每个 scriptDetails15s 或 shots 项追加 materialType、narrativeRole、classificationEvidence。
  materialType 仅取五种可生产镜头类型：talking_head（有画内讲话证据的真人口播）、factory（工厂生产过程实拍）、product（产品实拍）、consumer_demo（消费者使用产品或效果演示，前端标注 D2C）、general（不属于前四类、但有明确可见证据的其他通用素材，如环境、道具、图形或转场）。只有证据不足、无法判断时才用 unknown；unknown 不是第六种素材类别。
  consumer_demo 只描述镜头，不表示整片 B2C/DTC；工厂背景中的前景真人口播属于 talking_head，不因环境改成 factory；画外音不能证明画内人在讲话。
  narrativeRole 仅取 hook、pain_point、capability_proof、product_intro、effect_proof、cta、transition、unknown，独立于素材类型。classificationEvidence 写本镜头分类的具体可见/可听依据；无法判断用 unknown，禁止填模板。
- 镜头按真实视觉/动作边界记录，不按台词句数凑镜头。口播段可能覆盖多个镜头，不能重复整段原话制造逐镜台词。
`;

export const GEMINI_ANALYSIS_DIRECTOR_CONTRACT = `${BENCHMARK_ANALYSIS_CONTRACT}
导演级分析规范：
- 严格分离 observedFacts（实际可见/可听事实）、inferredIntent（推断意图）和 causalGap（视频未展示的因果动作）。causalGap 绝不能写入 visual、beats 或 omniPrompt。
- 将平台 UI、贴纸、字幕层与真人/产品/场景分开。无法确认的台词、字幕、品牌、价格、型号、认证和左右方向留空，并设置 needsReview=true。
- 动作必须可执行：记录主体初始状态、手与物体是否接触、动作路径、速度、结束状态、视线、姿态和真实运镜。
- 每镜独立输出景别 shot、运镜 camera、视角 angle、构图 composition 和营销功能 purpose。
- 建立全片 globalSettings 与 spatialContinuity，锁定人物身份、服装、产品外观/Logo朝向、左右手、道具、站位、朝向、光源方向和背景优先级。
- 每镜输出 startState、endState、transitionToNext；下一镜 startState 必须与上一镜 endState 一致。
- backgroundPriority 使用 low/medium/high；depthOfField 使用 shallow/moderate/deep。工厂、仓库、展会、教程和环境证明不得默认虚化背景。
- dialogue、onScreenText、ambientSound、bgm、soundEffects 必须分开。
- estimatedSpeechDuration 按正常语速估算；dialogueFits 判断台词能否在镜头时长内自然说完。
- omniPrompt 与 omniNegativePrompt 使用英文，前者只复现可见动作，后者约束身份、手部、产品、文字、物理关系和跨镜连续性错误。

在原有必需字段之外必须输出：
- globalSettings: { visualStyle, aspectRatio, lighting, subtitlePolicy, audioPolicy, identityConsistency, productConsistency, negativeConstraints[] }
- spatialContinuity: { scene, subjectAnchors:[{subject,position,facing,gazeTarget,orientation}], background, backgroundPriority, depthOfField }
- scriptDetails15s 每项追加 angle、composition、startState、endState、transitionToNext、backgroundPriority、depthOfField、estimatedSpeechDuration、dialogueFits。
`;

export const GEMINI_STORYBOARD_DIRECTOR_CONTRACT = `
脚本导演规范：
- 只复用对标视频的钩子类型、信息顺序、证明位置、镜头节奏、情绪曲线和 CTA 位置；禁止复制竞品身份、原台词、独特表达或未经产品资料支持的承诺。
- 先清理并集中全局控制：画风、比例、光影、字幕策略、音频策略、人物一致性、产品一致性和负向约束不得在每镜机械重复。
- 先建立空间锚定，再写分镜。锁定主体站位、朝向、视线、距离、遮挡、产品朝向、背景优先级和景深。
- 每镜必须输出独立的 shot、camera、angle、composition、purpose，并把抽象情绪改写成姿态、表情、视线、手部接触、动作路径和结束状态。
- 每镜输出 startState、endState、transitionToNext；下一镜初始状态必须等于上一镜结束状态。
- 口播、画面字幕、环境声、BGM和音效分开。字幕默认作为后期层，除非明确要求视频模型渲染文字。
- 时间从 0 连续递增，不重叠、不跳跃；duration=endTime-startTime。不要强制15秒，服从请求总时长。
- 中文正常语速按每秒4-5字并预留0.5-1.5秒表演停顿；台词放不下时缩短、拆镜或延长，设置 estimatedSpeechDuration 与 dialogueFits。
- generationPrompt 与 negativePrompt 使用英文，强调动作可执行性、身份/产品/物理关系/文字/跨镜一致性。
`;
