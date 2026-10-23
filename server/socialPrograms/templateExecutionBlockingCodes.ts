/** Read-only frozen template input/evidence failures, never provider/storage outcomes. */
export const TEMPLATE_EXECUTION_INPUT_BLOCKERS = new Set([
  'content_template_ref_invalid', 'content_template_candidate_corrupt',
  'content_template_confirmation_corrupt', 'content_template_execution_task_identity',
  'content_template_execution_scope_invalid', 'content_template_execution_selection_mismatch',
  'content_template_execution_source_mismatch', 'content_template_evidence_changed',
]);
export const TEMPLATE_EXECUTION_RESUMABLE_REASONS = new Set([
  ...TEMPLATE_EXECUTION_INPUT_BLOCKERS,
  'content_template_execution_selection_required', 'content_template_candidate_required',
  'content_template_confirmation_required',
]);
