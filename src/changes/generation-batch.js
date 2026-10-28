      // The context lives only inside this atomic batch. A rolled-back older Worker does not opt in,
      // so trigger side effects cannot break its exact generation row-count checks.
      const measured = await env.DB.batch([
        env.DB.prepare("INSERT INTO change_generation_context VALUES(1)"),
        ...q.flatMap(stmt => [stmt, env.DB.prepare("SELECT changes() AS direct_changes")]),
        env.DB.prepare(`INSERT INTO change_generation_coverage(publisher_id,snapshot_id)
          SELECT id,current_snapshot_id FROM publishers WHERE id=? AND current_snapshot_id=?
          ON CONFLICT(publisher_id) DO UPDATE SET snapshot_id=excluded.snapshot_id`).bind(p.id,sid),
        env.DB.prepare("DELETE FROM change_generation_context WHERE id=1")
      ]);
      res = q.map((_, i) => ({ ...measured[1+2*i], meta: { ...measured[1+2*i].meta, changes: measured[2+2*i].results[0].direct_changes } }));
