-- App Connect shared editing (docs/app-connect.md#shared-editing). When the owner allows it, on the consent page or
-- later in Settings -> Connections -> Publishing apps, people and agents with write access to the project may edit,
-- rename and trash the app's files too (they stay in the app's folders), not only the app. 0 = only the app (the default, and every connection
-- before this). Additive and retry-safe: the previous Worker never reads the column, so rolling back the Worker makes
-- every app file protected again; nothing is lost.
ALTER TABLE publishers ADD COLUMN shared_edit INTEGER NOT NULL DEFAULT 0;
