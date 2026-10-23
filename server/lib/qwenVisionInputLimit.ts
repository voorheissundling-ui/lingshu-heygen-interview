/** Accepted input-token ceiling, distinct from the published pricing-tier edge.
 * Keep planning, request measurement and published-tariff admission identical. */
export function qwenVisionInputLimit(model:string):number{
 if(/^qwen3-vl-plus(?:-\d{4}-\d{2}-\d{2})?$/.test(model))return 260096;
 if(/^qwen3-vl-flash(?:-\d{4}-\d{2}-\d{2})?$/.test(model))return 262144;
 if(/^qwen-vl-max(?:-\d{4}-\d{2}-\d{2})?$/.test(model))return 129024;
 throw Error('qwen_vision_input_limit_model_unsupported');
}
