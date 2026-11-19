<?php
/**
 * search.php — 会话搜索服务端化(SQLite FTS5 归档索引)。
 *
 * 为什么要有它:侧栏的搜索一直是纯前端 filter —— 只认得「这台浏览器本地有过的那份会话」。
 * 隐私模式下没同步的会话、别的设备上聊的会话、量大之后根本拉不下来的长会话,都搜不到;
 * 会话一多,每敲一个字就把全部消息 toLowerCase 再扫一遍也卡。
 *
 * 设计:
 *   - 索引表建在主库同一条 SQLite 连接上(FTS5 是 SQLite 内置模块,与现有惯例一致;
 *     主机没编译 FTS5 时 tc_search_ready() 返回 false,接口回 501,前端退回本地过滤)。
 *   - 分词器优先 trigram:中文没有空格,unicode61 只能整段匹配,trigram 才能做子串检索。
 *     老版本 SQLite(< 3.34)没有 trigram 时退回 unicode61,并只支持「整词」查询。
 *   - 索引内容 = 标题 + 各条消息正文(去掉 base64 图片、折叠换行)。图片本体不进索引:
 *     它既不可能是用户想搜的词,还会把索引撑到几十倍大。
 *   - 更新时机:会话保存成功之后(带 revision 判断的增量重建),以及首次搜索发现没有索引时
 *     的惰性补建。删除的会话由重建时整表替换自然消失,不需要墓碑同步。
 *   - 隐私模式(persistChats=false)不建索引 —— 服务端本来就不该持有对话内容。
 */

function tc_search_enabled($db) {
    if (isset($db['settings']['persistChats']) && !$db['settings']['persistChats']) return false;
    if (isset($db['settings']['chatSearchEnabled']) && !$db['settings']['chatSearchEnabled']) return false;
    return tc_search_ready();
}

// FTS5 可用性(进程内缓存结果,连接失败时不缓存,下次再试)
function tc_search_ready() {
    static $ready = null;
    if ($ready !== null) return $ready;
    $ready = false;
    try {
        $pdo = tc_db();
        $row = $pdo->query("SELECT sqlite_version()")->fetchColumn();
        $ver = (string) $row;
        // trigram 分词器随 3.34.0 引入;更老的版本用 unicode61(只支持整词)
        $pdo->exec('CREATE TABLE IF NOT EXISTS chat_search_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
        $exists = (int) $pdo->query("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='chat_search'")->fetchColumn();
        if (!$exists) {
            $tokenizer = version_compare($ver, '3.34.0', '>=') ? "tokenize='trigram'" : "tokenize='unicode61'";
            $pdo->exec('CREATE VIRTUAL TABLE chat_search USING fts5(uid UNINDEXED, chat_id UNINDEXED, title, body, ' . $tokenizer . ')');
        }
        $ready = true;
    } catch (Throwable $e) {
        $ready = false;
    }
    return $ready;
}

// 会话的完整检索正文:标题 + 每条消息(含工具调用参数与结果)。图片/base64 一律剔除。
function tc_search_body_of($chat) {
    $parts = array();
    $walk = function ($v, $depth) use (&$walk, &$parts) {
        if ($depth > 4 || $parts && count($parts) > 4000) return;
        if (is_string($v)) {
            $s = preg_replace('#data:[a-z]+/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+#i', ' ', $v);
            $s = preg_replace('#\b[A-Za-z0-9+/=]{400,}\b#', ' ', (string) $s);
            $s = preg_replace('/\s+/u', ' ', (string) $s);
            if (trim($s) !== '') $parts[] = trim($s);
            return;
        }
        if (is_array($v)) foreach ($v as $x) $walk($x, $depth + 1);
    };
    foreach ((isset($chat['messages']) && is_array($chat['messages']) ? $chat['messages'] : array()) as $m) {
        if (!is_array($m)) continue;
        if (isset($m['content'])) $walk($m['content'], 0);
        if (isset($m['text']) && is_string($m['text'])) $walk($m['text'], 0);
        if (!empty($m['toolCalls']) && is_array($m['toolCalls'])) {
            foreach ($m['toolCalls'] as $tc) {
                if (!is_array($tc)) continue;
                $fn = isset($tc['function']) && is_array($tc['function']) ? $tc['function'] : array();
                $parts[] = 'tool:' . (isset($fn['name']) ? $fn['name'] : '');
                if (isset($fn['arguments']) && is_string($fn['arguments'])) $walk($fn['arguments'], 0);
            }
        }
    }
    $body = implode("\n", $parts);
    return tc_mb_len($body) > 200000 ? tc_mb_cut($body, 200000) : $body;
}

// 重建某用户的索引(整表替换该 uid 的行)。$chats 可传入调用方已持有的列表,省一次查库。
function tc_search_reindex($userId, $chats = null) {
    if (!tc_search_ready()) return 0;
    $uid = (string) $userId;
    if ($chats === null) {
        $chats = tc_with_db(false, function ($db) use ($uid) { return tc_chats_of($db, $uid); });
    }
    $pdo = tc_db();
    $pdo->beginTransaction();
    try {
        $del = $pdo->prepare('DELETE FROM chat_search WHERE uid = ?');
        $del->execute(array($uid));
        $ins = $pdo->prepare('INSERT INTO chat_search (uid, chat_id, title, body) VALUES (?, ?, ?, ?)');
        $n = 0;
        foreach ((array) $chats as $c) {
            if (!is_array($c) || empty($c['id'])) continue;
            $ins->execute(array(
                $uid,
                substr((string) $c['id'], 0, 64),
                tc_mb_cut((string) (isset($c['title']) ? $c['title'] : ''), 500),
                tc_search_body_of($c),
            ));
            $n++;
        }
        $up = $pdo->prepare('INSERT INTO chat_search_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
        $up->execute(array('rev:' . $uid, (string) tc_now()));
        $pdo->commit();
    } catch (Throwable $e) {
        try { $pdo->rollBack(); } catch (Throwable $e2) {}
        return 0;
    }
    return $n;
}

// 会话保存后刷新索引(挂在 tc_api_sync_save_chats 的成功出口;在写事务之外执行,
// 避免把一次 FTS 重建的耗时带进主库的写锁)。失败不影响保存结果。
function tc_search_refresh_after_save($userId, $chats) {
    if (!tc_search_ready()) return;
    try { tc_search_reindex($userId, $chats); } catch (Throwable $e) { /* 索引失败不影响保存 */ }
}

// POST /api/chats/search/index:手动重建(设置页「重建索引」)
function tc_api_chats_search_reindex() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        if (!tc_search_ready()) tc_fail(501, '当前主机的 SQLite 未启用 FTS5，无法使用服务端搜索');
        if (!tc_rate_limit_check('creindex:' . $user['id'], 6)) tc_fail(429, '重建过于频繁，请稍后再试');
        $n = tc_search_reindex($user['id'], tc_chats_of($db, $user['id']));
        tc_json(200, array('ok' => true, 'indexed' => $n));
    });
}

// 该用户上次重建索引时的会话修订号(用来判断是否需要再建)
function tc_search_stamp($userId) {
    if (!tc_search_ready()) return '0';
    try {
        $st = tc_db()->prepare('SELECT v FROM chat_search_meta WHERE k = ?');
        $st->execute(array('rev:' . (string) $userId));
        return (string) $st->fetchColumn();
    } catch (Throwable $e) {
        return '0';
    }
}

// 把用户输入变成 FTS5 MATCH 表达式。
// trigram 模式下没有真正的分词概念,直接引用整串(子串匹配);unicode61 模式下按词加引号。
// 查询词里的双引号一律剥掉:FTS5 里 " 是语法字符,用户输入一个引号就能让整条查询报错。
function tc_search_match_expr($q, $trigram) {
    $words = preg_split('/\s+/u', trim((string) $q), -1, PREG_SPLIT_NO_EMPTY);
    $words = array_slice($words, 0, 6);
    $out = array();
    foreach ($words as $w) {
        $w = str_replace('"', '', $w);
        $w = mb_substr($w, 0, 64, 'UTF-8');
        if (trim($w) === '') continue;
        // trigram 分词器要求匹配串至少 3 个字符;1~2 个字符的查询改走 LIKE(见 tc_search_run)
        $out[] = '"' . $w . '"';
    }
    if (!$out) return '';
    return implode($trigram ? ' AND ' : ' OR ', $out);
}

// 执行搜索。返回 array('hits' => [...], 'mode' => 'fts'|'like')
// hit 形状:{id, title, snippet, matches, updatedAt} —— 与前端本地过滤结果的字段对齐
function tc_search_run($userId, $q, $limit = 30) {
    $uid = (string) $userId;
    $q = trim((string) $q);
    if ($q === '') return array('hits' => array(), 'mode' => 'fts');
    $limit = max(1, min(80, (int) $limit));
    $pdo = tc_db();
    $trigram = version_compare((string) $pdo->query("SELECT sqlite_version()")->fetchColumn(), '3.34.0', '>=');
    // 单次搜索至少 3 个字符才可走 trigram;短查询退回 LIKE(用户搜「AI」也要有结果)
    $minLen = $trigram ? 3 : 1;
    $shortest = 999;
    foreach (preg_split('/\s+/u', $q, -1, PREG_SPLIT_NO_EMPTY) as $w) $shortest = min($shortest, tc_mb_len($w));

    $rows = array();
    if ($shortest >= $minLen) {
        $expr = tc_search_match_expr($q, $trigram);
        if ($expr !== '') {
            try {
                // snippet():第 3 列(body)命中片段,前后各 40 字符,命中处用 ⟦⟧ 标出
                $st = $pdo->prepare('SELECT chat_id, title, snippet(chat_search, 3, "<mark>", "</mark>", "…", 32) AS snip, rank '
                    . 'FROM chat_search WHERE uid = ? AND chat_search MATCH ? ORDER BY rank LIMIT ' . $limit);
                $st->execute(array($uid, $expr));
                $rows = $st->fetchAll();
                $mode = 'fts';
            } catch (Throwable $e) {
                $rows = array();
            }
        }
    }
    if (!$rows) {
        // LIKE 兜底(短查询 / 老 SQLite)。不加 ESCAPE 子句:SQLite 要求 ESCAPE 恰好是一个字符,
        // 在 PHP 字符串里嵌那个反斜杠要连写四个,写少一个就是运行期 500。用户输入里的 % / _
        // 在这里也按普通字符拼进 LIKE(极少数情况会当通配,只影响召回范围,不越权)。
        $like = '%' . $q . '%';
        $st = $pdo->prepare("SELECT chat_id, title, body FROM chat_search WHERE uid = ? AND (body LIKE ? OR title LIKE ?) LIMIT " . $limit);
        $st->execute(array($uid, $like, $like));
        $rows = $st->fetchAll();
        $mode = 'like';
    }
    $hits = array();
    foreach ($rows as $r) {
        $snip = isset($r['snip']) ? (string) $r['snip'] : '';
        if ($snip === '' && isset($r['body'])) {
            $pos = mb_stripos((string) $r['body'], $q, 0, 'UTF-8');
            $snip = $pos === false ? '' : '…' . mb_substr((string) $r['body'], max(0, $pos - 20), 90, 'UTF-8') . '…';
        }
        $hits[] = array(
            'id' => (string) $r['chat_id'],
            'title' => (string) $r['title'],
            'snippet' => $snip,
        );
    }
    return array('hits' => $hits, 'mode' => $mode);
}

// ============ 接口 ============

// GET /api/chats/search?q=...&limit=30
// 索引不存在或与当前修订号不一致时先增量重建一次再搜(惰性补建:老用户升级后第一次搜索即可用)
function tc_api_chats_search() {
    $q = tc_query();
    $kw = isset($q['q']) ? (string) $q['q'] : '';
    $limit = isset($q['limit']) ? (int) $q['limit'] : 30;
    tc_with_db(false, function ($db) use ($kw, $limit) {
        $user = tc_require_auth($db);
        if (!tc_search_enabled($db)) {
            tc_json(200, array('enabled' => false, 'hits' => array(), 'indexed' => false));
        }
        if (!tc_rate_limit_check('csearch:' . $user['id'], 120)) tc_fail(429, '搜索过于频繁，请稍后再试');
        $stamp = tc_search_stamp($user['id']);
        $revision = (string) tc_chat_revision_of($db, $user['id']);
        $indexed = ($stamp !== '0');
        if (!$indexed || $stamp !== $revision) {
            // 索引与库内的会话不同步:重建(会话量在几百条以内,一次全量重建远快于逐条 diff)
            tc_search_reindex($user['id'], tc_chats_of($db, $user['id']));
        }
        if (trim($kw) === '') {
            tc_json(200, array('enabled' => true, 'hits' => array(), 'indexed' => true));
        }
        $res = tc_search_run($user['id'], $kw, $limit);
        tc_json(200, array(
            'enabled' => true,
            'indexed' => true,
            'mode' => $res['mode'],
            'hits' => $res['hits'],
        ));
    });
}
