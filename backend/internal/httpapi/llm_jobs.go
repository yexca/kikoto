package httpapi

import (
	"context"
	"errors"
)

// An LLM translation run (`llm_translation`) translated one work for review on
// its work page. Translate with AI replaces it, so a run queued before the
// upgrade, or retried after it, ends without a request and creates no preview.

// llmTranslationReplaced is the failure code of an LLM translation task whose
// run ended without a request.
const llmTranslationReplaced = "translation_replaced"

const llmTranslationReplacedMessage = "LLM translation is replaced by Translate with AI; translate the work there"

// stopLLMTranslationJob ends a queued LLM translation run without a request.
func (s *Server) stopLLMTranslationJob(ctx context.Context, job workflowJobRecord) error {
	ctx = context.WithoutCancel(ctx)
	if _, err := s.db.ExecContext(ctx, `UPDATE llm_translation_task SET state = 'invalid', failure_code = ?, updated_at = CURRENT_TIMESTAMP
		WHERE workflow_run_id = ? AND state <> 'cancelled'`, llmTranslationReplaced, job.RunID); err != nil {
		return err
	}
	if err := s.failClaimedWorkflowJob(ctx, job, llmTranslationReplacedMessage); err != nil {
		return err
	}
	return errors.New(llmTranslationReplacedMessage)
}

// retryLLMTranslationRun refuses the retry Activity offers: the run would end
// again without a request.
func (s *Server) retryLLMTranslationRun(context.Context, currentUser, int64) (workflowRetryDispatchResult, error) {
	return workflowRetryDispatchResult{}, errWorkflowRetryNoRecoverableJob
}
