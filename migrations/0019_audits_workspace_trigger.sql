-- Additive and retry-safe. Every audit row about a project records that project's workspace, whichever code path
-- (or rolled-back Worker) wrote it. Rows that name their workspace explicitly, or have no project, are untouched.
CREATE TRIGGER IF NOT EXISTS audits_workspace_fill AFTER INSERT ON audits
  WHEN NEW.workspace_id IS NULL AND NEW.project_id IS NOT NULL
BEGIN
  UPDATE audits SET workspace_id = (SELECT COALESCE(p.workspace_id, 'wsp_' || p.owner_id) FROM projects p WHERE p.id = NEW.project_id)
    WHERE seq = NEW.seq;
END;
