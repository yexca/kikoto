-- Translation coverage counts each listed work's queued translations by the
-- requester and the work's family, and a translation run reads its own task,
-- so neither scans the whole task history.
CREATE INDEX idx_llm_translation_task_user_work ON llm_translation_task(user_id, work_id, state);

CREATE INDEX idx_fk_llm_translation_task_workflow_run_id ON llm_translation_task(workflow_run_id);

CREATE INDEX idx_fk_llm_translation_task_work_id ON llm_translation_task(work_id);
