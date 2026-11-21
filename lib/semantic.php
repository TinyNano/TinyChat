<?php
/**
 * semantic.php — Embeddings 语义搜索(会话搜索 + 问笔记)。
 *
 * 与 search.php(FTS5 关键词)的分工:
 *   - 关键词搜索解决「记得原话、想找回那一条」;
 *   - 语义搜索解决「记得意思、想找到相关的那几条」。两者互不替代:纯向量检索对精确
 *     术语/代码片段召回并不好,所以 openai-chat 的会话搜索仍然是 FTS5,语义结果只作补充。
 *
 * 存储:主库存 SQLite 表 semantic_vec(uid/kind/id/h/text/v/t),写入按事务整组替换 ——
 * 旧方案(每用户一个 JSON 文件、每次索引全量读写)在真实 embeddings 的 1536 维下
 * 是每用户约 5MB 的 JSON 反复解析,规模一上来就疼。旧 JSON 文件首次遇到时自动迁入表
 * 并改名为 .migrated 保留备份;主机没有可用 SQLite 时退回文件方案。
 * 条目数有上限(默认 400),超了就按最近使用淘汰。
 *
 * 计算:向量已归一化,余弦相似度退化成点积,PHP 端对几百条 × 几百维足够快,
 * 不需要装任何扩展。
 *
 * 调用面:后台设置「语义搜索」(settings.semanticEnabled)总开关 + 指定的 embeddings 供应商
 * (semanticProviderId)+ 模型名(semanticModel)。自己带 Key 的供应商同样可用,计费与
 * 普通对话一致(按模型单价)。未配置时接口回 enabled=false,前端静默隐藏入口。
 */

define('TC_VEC_MAX_ITEMS', 400);
define('TC_VEC_TEXT_MAX', 4000);
define('TC_VEC_DIM_MAX', 4096);

function tc_vec_dir() {
    $dir = tc_data_dir() . '/vectors';
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    return $dir;
}
function tc_vec_file($userId) {
    return tc_vec_dir() . '/' . preg_replace('/[^A-Za-z0-9_-]/', '_', (string) $userId) . '.json';
}

// 向量表:与 chat_search(FTS5)同一个 SQLite 库。普通表不依赖 FTS5,任何 SQLite 都能建。
function tc_vec_sqlite_ready() {
    static $ready = null;
    if ($ready !== null) return $ready;
    $ready = false;
    try {
        $pdo = tc_db();
        $pdo->exec('CREATE TABLE IF NOT EXISTS semantic_vec (uid TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, h TEXT NOT NULL, text TEXT NOT NULL, v TEXT NOT NULL, t INTEGER NOT NULL, PRIMARY KEY (uid, kind, id))');
        $ready = true;
    } catch (Throwable $e) {
        $ready = false;   // 没有可用的 SQLite:退回文件方案
    }
    return $ready;
}

// 旧 JSON 文件迁入表:只在该用户表为空时执行一次,迁完把文件改名保留备份。
// 迁移写失败时不改名 —— 下次再试,文件方案与新表互不覆盖。
function tc_vec_migrate_legacy($userId, $pdo) {
    $file = tc_vec_file($userId);
    if (!is_file($file)) return;
    $cnt = (int) $pdo->query('SELECT COUNT(*) FROM semantic_vec WHERE uid = ' . $pdo->quote((string) $userId))->fetchColumn();
    if ($cnt === 0) {
        $j = json_decode((string) @file_get_contents($file), true);
        if (is_array($j) && $j) {
            $st = $pdo->prepare('INSERT OR REPLACE INTO semantic_vec (uid, kind, id, h, text, v, t) VALUES (?,?,?,?,?,?,?)');
            foreach ($j as $it) {
                if (!is_array($it) || empty($it['id']) || empty($it['v'])) continue;
                $st->execute(array(
                    (string) $userId,
                    (string) (isset($it['kind']) ? $it['kind'] : 'notes'),
                    (string) $it['id'],
                    (string) (isset($it['h']) ? $it['h'] : ''),
                    (string) (isset($it['text']) ? $it['text'] : ''),
                    tc_json_encode($it['v']),
                    (int) (isset($it['t']) ? $it['t'] : 0),
                ));
            }
        }
    }
    @rename($file, $file . '.migrated');
}

// 读取向量条目(条目形状与旧方案一致: [{kind,id,h,text,v,t}])。SQLite 不可用时退回文件。
function tc_vec_load($userId) {
    if (tc_vec_sqlite_ready()) {
        try {
            $pdo = tc_db();
            tc_vec_migrate_legacy($userId, $pdo);
            $st = $pdo->prepare('SELECT kind, id, h, text, v, t FROM semantic_vec WHERE uid = ?');
            $st->execute(array((string) $userId));
            $out = array();
            foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
                $v = json_decode((string) $r['v'], true);
                if (!is_array($v)) continue;
                $out[] = array('kind' => (string) $r['kind'], 'id' => (string) $r['id'], 'h' => (string) $r['h'], 'text' => (string) $r['text'], 'v' => $v, 't' => (int) $r['t']);
            }
            return $out;
        } catch (Throwable $e) { /* 落到文件方案 */ }
    }
    $file = tc_vec_file($userId);
    if (!is_file($file)) return array();
    $raw = @file_get_contents($file);
    $j = json_decode((string) $raw, true);
    return is_array($j) ? $j : array();
}

// 写回向量条目:单事务整组替换(约 400 行,本地 SQLite 毫秒级)。
// 旧方案用「临时文件 + rename」防半截;表方案由事务保证原子。
// SQLite 不可用时退回文件(临时文件 + rename,同样防半截 JSON)。
function tc_vec_save($userId, $items) {
    if (tc_vec_sqlite_ready()) {
        $own = false;
        try {
            $pdo = tc_db();
            $own = !$pdo->inTransaction();
            if ($own) $pdo->beginTransaction();
            $pdo->prepare('DELETE FROM semantic_vec WHERE uid = ?')->execute(array((string) $userId));
            $st = $pdo->prepare('INSERT OR REPLACE INTO semantic_vec (uid, kind, id, h, text, v, t) VALUES (?,?,?,?,?,?,?)');
            foreach ($items as $it) {
                if (!is_array($it) || empty($it['id']) || empty($it['v'])) continue;
                $st->execute(array(
                    (string) $userId,
                    (string) (isset($it['kind']) ? $it['kind'] : 'notes'),
                    (string) $it['id'],
                    (string) (isset($it['h']) ? $it['h'] : ''),
                    (string) (isset($it['text']) ? $it['text'] : ''),
                    tc_json_encode(isset($it['v']) ? $it['v'] : array()),
                    (int) (isset($it['t']) ? $it['t'] : 0),
                ));
            }
            if ($own) $pdo->commit();
            return true;
        } catch (Throwable $e) {
            try { if ($own && isset($pdo) && $pdo->inTransaction()) $pdo->rollBack(); } catch (Throwable $e2) { /* 忽略 */ }
            /* 落到文件方案 */
        }
    }
    $file = tc_vec_file($userId);
    $tmp = $file . '.' . getmypid() . '.tmp';
    $ok = @file_put_contents($tmp, tc_json_encode($items), LOCK_EX);
    if ($ok === false) return false;
    return @rename($tmp, $file);
}

function tc_vec_normalize($vec) {
    $sum = 0.0;
    foreach ($vec as $v) $sum += $v * $v;
    $len = sqrt($sum);
    if ($len <= 0) return $vec;
    $out = array();
    foreach ($vec as $v) $out[] = $v / $len;
    return $out;
}

function tc_vec_dot($a, $b) {
    $n = min(count($a), count($b));
    $d = 0.0;
    for ($i = 0; $i < $n; $i++) $d += $a[$i] * $b[$i];
    return $d;
}

// 当前配置是否可用:总开关 + 指定了供应商与模型
function tc_semantic_settings($db) {
    $s = isset($db['settings']) && is_array($db['settings']) ? $db['settings'] : array();
    return array(
        'enabled' => !empty($s['semanticEnabled']) && !empty($s['semanticProviderId']) && !empty($s['semanticModel']),
        'providerId' => isset($s['semanticProviderId']) ? (string) $s['semanticProviderId'] : '',
        'model' => isset($s['semanticModel']) ? (string) $s['semanticModel'] : '',
    );
}

// 调一次上游 /embeddings。返回 array('ok'=>bool, 'vectors'=>[[float]], 'error'=>string)
function tc_embedding_call($provider, $model, $texts, $timeoutMs = 30000) {
    if (!$texts) return array('ok' => true, 'vectors' => array());
    $base = rtrim((string) (isset($provider['baseUrl']) ? $provider['baseUrl'] : ''), '/');
    if ($base === '') return array('ok' => false, 'error' => '语义搜索的供应商未配置 Base URL');
    $url = tc_api_url($base, '/embeddings');
    // SSRF 闸门与对话代理同一套(内网/保留地址拒绝);失败原因原样带出 —— 只说「地址不可用」
    // 时,管理员分不清是填了内网地址、还是 DNS 没解析,更看不出该改哪里
    if (!tc_upstream_url_is_safe($url)) {
        return array('ok' => false, 'error' => '语义搜索的供应商地址不可用（不允许内网或保留地址）：' . $url);
    }
    $key = tc_provider_key_for_model($provider, $model);
    $headers = tc_upstream_auth_headers('chat', $key, false);
    $body = tc_json_encode(array('model' => $model, 'input' => array_values(array_map(function ($t) {
        return tc_mb_cut((string) $t, TC_VEC_TEXT_MAX);
    }, $texts))));
    $res = tc_http_request($url, 'POST', $headers, $body, $timeoutMs);
    if (empty($res['ok'])) return array('ok' => false, 'error' => tc_upstream_fail_message($res, isset($provider['name']) ? $provider['name'] : ''));
    if ((int) $res['status'] >= 400) {
        return array('ok' => false, 'error' => (isset($provider['name']) && $provider['name'] !== '' ? '「' . $provider['name'] . '」' : '') . tc_upstream_error_message($res['body'], $res['status']));
    }
    $j = json_decode((string) $res['body'], true);
    $rows = is_array($j) && isset($j['data']) && is_array($j['data']) ? $j['data'] : null;
    if (!$rows) return array('ok' => false, 'error' => '上游没有返回向量（请确认该模型支持 /embeddings）');
    // data 里带 index,按它排序还原与输入一一对应的顺序
    usort($rows, function ($a, $b) {
        return (int) (isset($a['index']) ? $a['index'] : 0) - (int) (isset($b['index']) ? $b['index'] : 0);
    });
    $vectors = array();
    foreach ($rows as $r) {
        $emb = isset($r['embedding']) && is_array($r['embedding']) ? $r['embedding'] : null;
        if (!$emb || count($emb) > TC_VEC_DIM_MAX) return array('ok' => false, 'error' => '上游返回的向量格式不对');
        $v = array();
        foreach ($emb as $x) $v[] = (float) $x;
        $vectors[] = tc_vec_normalize($v);
    }
    if (count($vectors) !== count($texts)) return array('ok' => false, 'error' => '上游返回的向量数量与输入不一致');
    return array('ok' => true, 'vectors' => $vectors);
}

// 为一批文本生成向量(内部用:建立索引)。失败返回 null。
function tc_embedding_for($db, $texts) {
    $cfg = tc_semantic_settings($db);
    if (!$cfg['enabled']) return null;
    $provider = null;
    foreach ((isset($db['providers']) ? $db['providers'] : array()) as $p) {
        if (is_array($p) && isset($p['id']) && (string) $p['id'] === $cfg['providerId']) { $provider = $p; break; }
    }
    if (!$provider) return null;
    // 每批最多 32 条:一次几百条对大多数供应商都会超限
    $out = array();
    foreach (array_chunk(array_values($texts), 32) as $chunk) {
        $r = tc_embedding_call($provider, $cfg['model'], $chunk, 30000);
        if (empty($r['ok'])) return null;
        foreach ($r['vectors'] as $v) $out[] = $v;
    }
    return $out;
}

// 更新某用户的语义索引。$rows: [{id, text}]。已存在的 id 且文本未变就跳过,
// 只给新增/变化的条目算向量 —— 每次保存会话都重算全部会烧掉大量额度。
function tc_semantic_index($userId, $db, $rows, $kind) {
    $cfg = tc_semantic_settings($db);
    if (!$cfg['enabled']) return 0;
    $existing = tc_vec_load($userId);
    $hashes = array();
    $next = array();
    foreach ($existing as $it) {
        if (!is_array($it) || empty($it['id'])) continue;
        // 只保留同类(kind)条目:会话与笔记共用一份文件,互不覆盖
        if ((isset($it['kind']) ? $it['kind'] : '') !== $kind) $next[] = $it;
        else $hashes[(string) $it['id']] = (string) $it['h'];
    }
    $todo = array();
    $todoMeta = array();
    foreach ($rows as $r) {
        $id = substr((string) (isset($r['id']) ? $r['id'] : ''), 0, 64);
        $text = trim((string) (isset($r['text']) ? $r['text'] : ''));
        if ($id === '' || $text === '') continue;
        $text = tc_mb_cut($text, TC_VEC_TEXT_MAX);
        $h = sha1($text);
        if (isset($hashes[$id]) && $hashes[$id] === $h) continue;
        $todo[] = $text;
        $todoMeta[] = array('id' => $id, 'h' => $h, 'text' => tc_mb_cut($text, 300));
    }
    if (!$todo) {
        // 内容没变:只剔除已删除的条目(新列表里没有 -> 从索引里去掉)
        $keepIds = array();
        foreach ($rows as $r) $keepIds[(string) $r['id']] = true;
        $filtered = array();
        foreach ($next as $it) {
            if ((isset($it['kind']) ? $it['kind'] : '') === $kind && !isset($keepIds[(string) $it['id']])) continue;
            $filtered[] = $it;
        }
        if (count($filtered) !== count($existing)) tc_vec_save($userId, $filtered);
        return 0;
    }
    $vectors = tc_embedding_for($db, $todo);
    if ($vectors === null) return -1;
    foreach ($todoMeta as $i => $m) {
        $next[] = array('kind' => $kind, 'id' => $m['id'], 'h' => $m['h'], 'text' => $m['text'], 'v' => $vectors[$i], 't' => tc_now());
    }
    // 上限淘汰:先按时间倒序,截断到上限
    usort($next, function ($a, $b) { return (int) (isset($b['t']) ? $b['t'] : 0) - (int) (isset($a['t']) ? $a['t'] : 0); });
    if (count($next) > TC_VEC_MAX_ITEMS) $next = array_slice($next, 0, TC_VEC_MAX_ITEMS);
    tc_vec_save($userId, $next);
    return count($todoMeta);
}

// 检索:返回 [{id, text, score}] 按相似度倒序
function tc_semantic_query($userId, $db, $query, $kind, $limit = 8) {
    $cfg = tc_semantic_settings($db);
    if (!$cfg['enabled']) return array('ok' => false, 'error' => '语义搜索未开启');
    $items = tc_vec_load($userId);
    $pool = array();
    foreach ($items as $it) {
        if (!is_array($it) || empty($it['v']) || (isset($it['kind']) ? $it['kind'] : '') !== $kind) continue;
        $pool[] = $it;
    }
    if (!$pool) return array('ok' => true, 'hits' => array(), 'indexed' => 0);
    $provider = null;
    foreach ((isset($db['providers']) ? $db['providers'] : array()) as $p) {
        if (is_array($p) && isset($p['id']) && (string) $p['id'] === $cfg['providerId']) { $provider = $p; break; }
    }
    if (!$provider) return array('ok' => false, 'error' => '语义搜索的供应商已被删除，请在后台重新指定');
    $q = tc_embedding_call($provider, $cfg['model'], array($query), 20000);
    if (empty($q['ok'])) return $q;
    $qv = $q['vectors'][0];
    $scored = array();
    foreach ($pool as $it) {
        $scored[] = array('id' => (string) $it['id'], 'text' => (string) (isset($it['text']) ? $it['text'] : ''), 'score' => tc_vec_dot($qv, $it['v']));
    }
    usort($scored, function ($a, $b) { return $a['score'] < $b['score'] ? 1 : ($a['score'] > $b['score'] ? -1 : 0); });
    // 低于 0.2 的基本都是无关内容(归一化向量点积的常见阈值),不返回以免噪声
    $hits = array_values(array_filter(array_slice($scored, 0, max(1, $limit)), function ($h) { return $h['score'] >= 0.2; }));
    return array('ok' => true, 'hits' => $hits, 'indexed' => count($pool));
}

// 公开状态(给前台决定是否显示语义搜索入口;不泄露供应商与模型细节)
function tc_semantic_public($db) {
    $cfg = tc_semantic_settings($db);
    return array('enabled' => (bool) $cfg['enabled']);
}

// ============ 接口 ============

// GET /api/me/semantic/stats:当前账号的索引状态(条目数 / 占用 / 最近更新)。
// 设置页据此显示「已索引 N 条 / 上次更新」,并提供「清空重建」——
// 之前索引只增不减,用户改了模型(维数不同)或怀疑索引脏了,没有任何出口。
function tc_api_me_semantic_stats() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        $cfg = tc_semantic_settings($db);
        $items = $cfg['enabled'] ? tc_vec_load($user['id']) : array();
        $byKind = array('notes' => 0, 'chats' => 0);
        $last = 0;
        foreach ($items as $it) {
            if (!is_array($it)) continue;
            $k = isset($it['kind']) && $it['kind'] === 'chats' ? 'chats' : 'notes';
            $byKind[$k]++;
            $t = (int) (isset($it['t']) ? $it['t'] : 0);
            if ($t > $last) $last = $t;
        }
        tc_json(200, array(
            'enabled' => (bool) $cfg['enabled'],
            'model' => $cfg['model'],
            'items' => count($items),
            'byKind' => $byKind,
            // 占用估算:向量 JSON 串 + 文本 + 固定开销(文件方案时代是文件大小,表方案按行算)
            'bytes' => array_sum(array_map(function ($it) { return isset($it['v']) ? strlen(tc_json_encode($it['v'])) + strlen((string) (isset($it['text']) ? $it['text'] : '')) + 40 : 0; }, $items)),
            'updatedAt' => $last,
        ));
    });
}

// DELETE /api/me/semantic:清空本账号的语义索引(下次检索前客户端会按需重建)
function tc_api_me_semantic_clear() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        $items = tc_vec_load($user['id']);
        $freed = array_sum(array_map(function ($it) { return isset($it['v']) ? strlen(tc_json_encode($it['v'])) + strlen((string) (isset($it['text']) ? $it['text'] : '')) + 40 : 0; }, $items));
        if (tc_vec_sqlite_ready()) {
            try { tc_db()->prepare('DELETE FROM semantic_vec WHERE uid = ?')->execute(array((string) $user['id'])); } catch (Throwable $e) { /* 文件方案兜底 */ }
        }
        $file = tc_vec_file($user['id']);
        if (is_file($file)) { $freed += (int) @filesize($file); @unlink($file); }
        // 迁移备份一并清掉,别让「清空」留下半份副本
        $mig = $file . '.migrated';
        if (is_file($mig)) @unlink($mig);
        tc_json(200, array('ok' => true, 'freedBytes' => $freed));
    });
}

// GET /api/me/semantic?kind=notes|chats&q=...
// 检索;客户端没索引过时先建(chats 用服务端保存的会话正文,notes 用请求体带来的笔记文本)。
function tc_api_me_semantic() {
    $q0 = tc_query();
    $kind = isset($q0['kind']) ? (string) $q0['kind'] : 'notes';
    $kw = isset($q0['q']) ? trim((string) $q0['q']) : '';
    if (!in_array($kind, array('notes', 'chats'), true)) tc_fail(400, 'kind 只能是 notes 或 chats');
    if ($kw === '') tc_json(200, array('enabled' => true, 'hits' => array()));
    $ctx = tc_with_db(false, function ($db) use ($kind) {
        $user = tc_require_auth($db);
        $cfg = tc_semantic_settings($db);
        return array('user' => $user, 'cfg' => $cfg, 'provider' => null);
    });
    if (!$ctx['cfg']['enabled']) tc_json(200, array('enabled' => false, 'hits' => array()));
    if (!tc_rate_limit_check('sem:' . $ctx['user']['id'], 20)) tc_fail(429, '语义搜索过于频繁，请稍后再试');
    // 每次查询都要真调一次上游:按站点对用户限流之外,不在这里做缓存(查询本身各不相同)
    $res = tc_with_db(false, function ($db) use ($ctx, $kind, $kw) {
        return tc_semantic_query($ctx['user']['id'], $db, $kw, $kind, 8);
    });
    if (empty($res['ok'])) tc_json(200, array('enabled' => true, 'error' => $res['error'], 'hits' => array()));
    tc_json(200, array('enabled' => true, 'hits' => $res['hits'], 'indexed' => isset($res['indexed']) ? $res['indexed'] : 0));
}

// POST /api/me/semantic/index  { kind: 'notes'|'chats', items: [{id, text}] }
// notes 由前端带正文(笔记存在本地+云端文档里,服务端虽有副本但以客户端当前编辑内容为准);
// chats 传 items: [] 时用服务端保存的会话正文。
function tc_api_me_semantic_index() {
    $done = tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        $cfg = tc_semantic_settings($db);
        if (!$cfg['enabled']) tc_json(200, array('enabled' => false, 'indexed' => 0));
        if (!tc_rate_limit_check('semi:' . $user['id'], 10)) tc_fail(429, '索引更新过于频繁，请稍后再试');
        $b = tc_read_json_body(8 * 1024 * 1024);
        $kind = isset($b['kind']) && $b['kind'] === 'chats' ? 'chats' : 'notes';
        $rows = array();
        if ($kind === 'chats') {
            foreach (tc_chats_of($db, $user['id']) as $c) {
                if (!is_array($c) || empty($c['id'])) continue;
                $text = (string) (isset($c['title']) ? $c['title'] : '') . "\n" . tc_search_body_of($c);
                $rows[] = array('id' => (string) $c['id'], 'text' => tc_mb_cut($text, TC_VEC_TEXT_MAX));
            }
        } else {
            $items = isset($b['items']) && is_array($b['items']) ? $b['items'] : array();
            foreach (array_slice($items, 0, TC_VEC_MAX_ITEMS) as $it) {
                if (!is_array($it)) continue;
                $rows[] = array('id' => (string) (isset($it['id']) ? $it['id'] : ''), 'text' => (string) (isset($it['text']) ? $it['text'] : ''));
            }
        }
        $n = tc_semantic_index($user['id'], $db, $rows, $kind);
        if ($n < 0) tc_json(200, array('enabled' => true, 'indexed' => 0, 'error' => '生成向量失败：上游 embeddings 接口不可用或未配置'));
        tc_json(200, array('enabled' => true, 'indexed' => $n, 'total' => count($rows)));
    });
}
