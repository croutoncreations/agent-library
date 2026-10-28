    // Derived generation index writes are explicit, not insert triggers: old Workers validate exact
    // D1 meta.changes for their nine-statement commit. Keep those checks intact on the new Worker too.
    q.push(env.DB.prepare(`INSERT OR IGNORE INTO artifact_search_keys(artifact_id)
      SELECT a.id FROM artifacts a WHERE a.publisher_id=? AND a.generation_id=? AND ${gate}`).bind(p.id,id,...gp));
    q.push(env.DB.prepare(`INSERT OR REPLACE INTO artifact_search (rowid,artifact_id,revision_id,sha256,title,body)
      SELECT k.search_id,a.id,r.id,r.sha256,a.title,COALESCE(r.body,'') FROM artifacts a JOIN artifact_search_keys k ON k.artifact_id=a.id
      JOIN revisions r ON r.id=a.head_revision_id AND r.artifact_id=a.id AND r.project_id=a.project_id AND r.rev_no=a.head_rev
      JOIN publisher_generations pg ON pg.id=a.generation_id AND pg.publisher_id=a.publisher_id AND pg.state='committed'
      WHERE a.publisher_id=? AND a.generation_id=? AND a.trashed_at IS NULL AND ${gate}`).bind(p.id,id,...gp));
    q.push(env.DB.prepare(`SELECT count(*) AS indexed_count FROM artifact_search s JOIN artifacts a ON a.id=s.artifact_id
      WHERE a.publisher_id=? AND a.generation_id=? AND s.revision_id=a.head_revision_id`).bind(p.id,id));
