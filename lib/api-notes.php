<?php
/**
 * api-notes.php — AI 笔记域的后端接口(从 lib/api.php 整体迁出,逻辑未改)。
 *
 * 包含:笔记文档同步(/api/sync/notes)、附件上传与签名 URL、分享与访客留言、
 * 云端版本历史、以及后台的笔记管理(列表 / 查看 / 清理)。
 *
 * 数据流与对话同步同构:客户端持有完整文档(folders/notes/tombs),通过 /api/sync/notes
 * 带 baseRevision 乐观并发推送;服务器按用户拆行存储(note:{uid}),不做逐字段合并。
 * 附件落盘 data/notes/{用户ID}/(整目录禁网),通过带 HMAC 签名的 URL 由 /api/notes/file 输出,
 * 非图片一律强制下载、不作为网页外链托管。
 *
 * 依赖 lib/api.php 里的通用件(tc_with_db / tc_json / tc_require_auth 等),由 index.php 先载入 api.php。
 */
require_once __DIR__ . '/api.php';

// ============ 存储层:文档 / 索引 / 附件签名 / 额度 ============

function tc_utf_cut($s, $n) {
    $s = (string) $s;
    return function_exists('mb_substr') ? mb_substr($s, 0, $n) : substr($s, 0, $n);
}

// 笔记功能可用性:总开关 × 访问级别(全站 / 仅管理员 / 仅名单),见 lib/features.php。
// 关闭时前台入口隐藏,接口一律拒绝(避免旧标签页继续写入)。
function tc_note_feature_guard($db, $user = null) {
    if ($user === null) $user = tc_require_auth($db);
    if (!tc_feature_allowed($db, $user, 'notes')) tc_fail(403, '本站未开放 AI 笔记功能，或你的账号没有使用权限');
    return $user;
}

// 笔记附件根目录:data/notes/ (整体禁网,只能经签名路由输出)
function tc_note_root_dir() {
    $dir = tc_data_dir() . '/notes';
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    return $dir;
}

// 用户附件目录:data/notes/{userId}/ —— 用不可变的用户 ID 而非用户名,
// 改名后路径不变,避免附件失联与越权落到他人目录。
function tc_note_user_dir($userId, $create = true) {
    $uid = preg_replace('/[^A-Za-z0-9_-]/', '', (string) $userId);
    if ($uid === '') return '';
    $dir = tc_note_root_dir() . '/' . $uid;
    if ($create && !is_dir($dir)) @mkdir($dir, 0755, true);
    return $dir;
}

// 该用户已用附件字节数(含 .bin 数据文件)
function tc_note_user_usage($userId) {
    $dir = tc_note_user_dir($userId, false);
    if ($dir === '' || !is_dir($dir)) return 0;
    $total = 0;
    foreach ((array) @glob($dir . '/*.bin') as $f) {
        $sz = @filesize($f);
        if ($sz !== false) $total += (int) $sz;
    }
    return $total;
}

// 空间上限(字节):站点设置 notesQuotaMb,0 = 不限
function tc_note_quota_bytes($db) {
    $mb = isset($db['settings']['notesQuotaMb']) ? (int) $db['settings']['notesQuotaMb'] : 0;
    return $mb > 0 ? $mb * 1048576 : 0;
}

function tc_notes_of($db, $userId) {
    $map = tc_assoc(isset($db['userNotes']) ? $db['userNotes'] : array());
    $doc = isset($map[$userId]) && is_array($map[$userId]) ? $map[$userId] : array();
    return array(
        'folders' => isset($doc['folders']) && is_array($doc['folders']) ? $doc['folders'] : array(),
        'notes' => isset($doc['notes']) && is_array($doc['notes']) ? $doc['notes'] : array(),
        'tombs' => tc_assoc(isset($doc['tombs']) ? $doc['tombs'] : array()),
    );
}

function tc_notes_revision_of($db, $userId) {
    $map = tc_assoc(isset($db['userNoteRevisions']) ? $db['userNoteRevisions'] : array());
    return isset($map[$userId]) ? (int) $map[$userId] : 0;
}

function tc_bump_notes_revision(&$db, $userId) {
    $revs = tc_assoc(isset($db['userNoteRevisions']) ? $db['userNoteRevisions'] : array());
    $revs[$userId] = tc_notes_revision_of($db, $userId) + 1;
    $db['userNoteRevisions'] = tc_object_map($revs);
}

function tc_set_notes(&$db, $userId, $doc) {
    $map = tc_assoc(isset($db['userNotes']) ? $db['userNotes'] : array());
    $map[$userId] = $doc;
    $db['userNotes'] = tc_object_map($map);
    tc_bump_notes_revision($db, $userId);
}

// 注销/删除用户时清理笔记数据(硬删与软删共用)
function tc_drop_user_notes(&$db, $id) {
    $noteMap = tc_assoc(isset($db['userNotes']) ? $db['userNotes'] : array());
    unset($noteMap[$id]);
    $db['userNotes'] = tc_object_map($noteMap);
    $revs = tc_assoc(isset($db['userNoteRevisions']) ? $db['userNoteRevisions'] : array());
    unset($revs[$id]);
    $db['userNoteRevisions'] = tc_object_map($revs);
    $shares = tc_assoc(isset($db['noteShares']) ? $db['noteShares'] : array());
    foreach ($shares as $t => $s) {
        if ((string) ($s['ownerId'] ?? '') === (string) $id) unset($shares[$t]);
    }
    $db['noteShares'] = tc_object_map($shares);
}

function tc_sanitize_note_tags($tags) {
    $out = array();
    foreach ((array) $tags as $t) {
        $t = trim((string) $t);
        if ($t === '') continue;
        $out[] = tc_utf_cut($t, 24);
        if (count($out) >= 20) break;
    }
    return array_values(array_unique($out));
}

function tc_sanitize_note_folder($f) {
    if (!is_array($f)) return null;
    $id = substr(trim((string) (isset($f['id']) ? $f['id'] : '')), 0, 64);
    if ($id === '') return null;
    $name = trim((string) (isset($f['name']) ? $f['name'] : ''));
    if ($name === '') return null;
    $parentId = substr(trim((string) (isset($f['parentId']) ? $f['parentId'] : '')), 0, 64);
    return array(
        'id' => $id,
        'parentId' => $parentId !== '' ? $parentId : null,
        'name' => tc_utf_cut($name, 80),
        'description' => tc_utf_cut(trim((string) (isset($f['description']) ? $f['description'] : '')), 200),
        'createdAt' => (float) (isset($f['createdAt']) ? $f['createdAt'] : tc_now()),
        'updatedAt' => (float) (isset($f['updatedAt']) ? $f['updatedAt'] : tc_now()),
    );
}

function tc_sanitize_note_row($n) {
    if (!is_array($n)) return null;
    $id = substr(trim((string) (isset($n['id']) ? $n['id'] : '')), 0, 64);
    if ($id === '') return null;
    $title = trim((string) (isset($n['title']) ? $n['title'] : ''));
    $atts = array();
    $rawAtts = isset($n['attachments']) && is_array($n['attachments']) ? $n['attachments'] : array();
    foreach (array_slice($rawAtts, 0, 50) as $a) {
        if (!is_array($a)) continue;
        $url = (string) (isset($a['url']) ? $a['url'] : '');
        if ($url === '' || strlen($url) > 600) continue;
        $atts[] = array(
            'id' => substr(trim((string) (isset($a['id']) ? $a['id'] : '')), 0, 64),
            'name' => tc_utf_cut((string) (isset($a['name']) ? $a['name'] : 'file'), 200),
            'url' => $url,
            'mimeType' => substr((string) (isset($a['mimeType']) ? $a['mimeType'] : ''), 0, 100),
            'size' => (int) (isset($a['size']) ? $a['size'] : 0),
            'createdAt' => (float) (isset($a['createdAt']) ? $a['createdAt'] : tc_now()),
        );
    }
    $src = isset($n['source']) && is_array($n['source']) ? $n['source'] : null;
    $shareMode = (string) (isset($n['shareMode']) ? $n['shareMode'] : 'private');
    if (!in_array($shareMode, array('private', 'view-link', 'edit-link'), true)) $shareMode = 'private';
    $note = array(
        'id' => $id,
        'folderId' => substr(trim((string) (isset($n['folderId']) ? $n['folderId'] : '')), 0, 64),
        'title' => tc_utf_cut($title !== '' ? $title : '无标题', 200),
        'content' => (string) (isset($n['content']) ? $n['content'] : ''),
        'tags' => tc_sanitize_note_tags(isset($n['tags']) ? $n['tags'] : array()),
        'attachments' => $atts,
        'isPinned' => !empty($n['isPinned']),
        'shareMode' => $shareMode,
        'shareToken' => substr(trim((string) (isset($n['shareToken']) ? $n['shareToken'] : '')), 0, 64),
        'createdAt' => (float) (isset($n['createdAt']) ? $n['createdAt'] : tc_now()),
        'updatedAt' => (float) (isset($n['updatedAt']) ? $n['updatedAt'] : tc_now()),
    );
    if ($note['folderId'] === '') $note['folderId'] = 'uncat';
    // 超长笔记给出明确错误,不再静默截断(截断会让用户以为保存成功、重开后尾部消失)
    if (strlen($note['content']) > TC_NOTE_MAX_CHARS) {
        tc_fail(413, '单篇笔记内容超过 ' . number_format(TC_NOTE_MAX_CHARS) . ' 字符上限，请拆分到多篇笔记');
    }
    if (is_array($src)) {
        $note['source'] = array(
            'conversationId' => substr(trim((string) (isset($src['conversationId']) ? $src['conversationId'] : '')), 0, 64),
            'messageId' => substr(trim((string) (isset($src['messageId']) ? $src['messageId'] : '')), 0, 64),
            'userQuestion' => substr((string) (isset($src['userQuestion']) ? $src['userQuestion'] : ''), 0, 2000),
            'generatedByAI' => !empty($src['generatedByAI']),
        );
    }
    return $note;
}

function tc_sanitize_notes_doc($doc) {
    if (!is_array($doc)) $doc = array();
    $folders = array();
    $seen = array();
    $rawFolders = isset($doc['folders']) && is_array($doc['folders']) ? $doc['folders'] : array();
    foreach (array_slice($rawFolders, 0, 300) as $f) {
        $row = tc_sanitize_note_folder($f);
        if ($row === null || isset($seen[$row['id']])) continue;
        $seen[$row['id']] = true;
        $folders[] = $row;
    }
    $notes = array();
    $rawNotes = isset($doc['notes']) && is_array($doc['notes']) ? $doc['notes'] : array();
    foreach (array_slice($rawNotes, 0, 2000) as $n) {
        $row = tc_sanitize_note_row($n);
        if ($row === null) continue;
        $notes[] = $row;
    }
    $tombs = array();
    $rawTombs = isset($doc['tombs']) && is_array($doc['tombs']) ? $doc['tombs'] : array();
    foreach (array_slice($rawTombs, 0, 500, true) as $tid => $ts) {
        $tid = substr(trim((string) $tid), 0, 64);
        if ($tid === '') continue;
        $tombs[$tid] = (int) $ts;
    }
    return array('folders' => $folders, 'notes' => $notes, 'tombs' => tc_object_map($tombs));
}

// 附件索引(data/notes/index.json):owners 为归属指纹→用户 ID,files 为附件 id→笔记 id。
// files 用于附件鉴权:读取时判定「该附件属于哪篇笔记」,据此决定谁能下载。
// 缓存放在可重置的静态引用里:写入后必须让本请求的后续读取看到新值,
// 否则同一请求里「先建附件、再查归属」会拿到过期结果。
function &tc_notes_index_cache_ref() {
    static $cache = null;
    return $cache;
}

function tc_notes_index_normalize($idx) {
    return array(
        'owners' => (isset($idx['owners']) && is_array($idx['owners'])) ? $idx['owners'] : array(),
        'files' => (isset($idx['files']) && is_array($idx['files'])) ? $idx['files'] : array(),
    );
}

function tc_notes_index_read() {
    $cache = &tc_notes_index_cache_ref();
    if ($cache !== null) return $cache;
    $j = json_decode((string) @file_get_contents(tc_note_root_dir() . '/index.json'), true);
    $cache = tc_notes_index_normalize(is_array($j) ? $j : array());
    return $cache;
}

function tc_notes_owner_index() { $i = tc_notes_index_read(); return $i['owners']; }

function tc_notes_index_write($idx) {
    $cache = &tc_notes_index_cache_ref();
    $cache = null;
    tc_json_mutate(tc_note_root_dir() . '/index.json', function ($cur) use ($idx) {
        // 合并而不是整体覆盖:并发的另一个请求刚加进去的附件映射不能被抹掉
        $next = tc_notes_index_normalize($idx);
        foreach (array('owners', 'files') as $k) {
            foreach ($next[$k] as $key => $v) $cur[$k][$key] = $v;
        }
        return $cur;
    }, array('owners' => array(), 'files' => array()));
}

// 记录归属(用户指纹)与附件→笔记映射
function tc_notes_index_add($userId, $fileId, $noteId) {
    $tag = tc_note_file_owner_tag($userId);
    $cache = &tc_notes_index_cache_ref();
    $cache = null;
    tc_json_mutate(tc_note_root_dir() . '/index.json', function ($cur) use ($userId, $tag, $fileId, $noteId) {
        $cur = tc_notes_index_normalize($cur);
        $cur['owners'][$tag] = (string) $userId;
        if ($fileId !== '' && $noteId !== '') $cur['files'][$fileId] = (string) $noteId;
        return $cur;
    }, array('owners' => array(), 'files' => array()));
}

function tc_notes_index_remove_file($fileId) {
    $cache = &tc_notes_index_cache_ref();
    $cache = null;
    tc_json_mutate(tc_note_root_dir() . '/index.json', function ($cur) use ($fileId) {
        $cur = tc_notes_index_normalize($cur);
        unset($cur['files'][$fileId]);
        return $cur;
    }, array('owners' => array(), 'files' => array()));
}

// 图片魔数校验:扩展名可伪造,这里按文件头判断真实类型。
// 返回检测到的 MIME,或 ''(不是受支持的图片)。
// 只对声明为图片的扩展名做校验——避免把 .html 改名成 .png 就当成图片内联输出。
function tc_note_sniff_image_mime($bytes) {
    $b = (string) $bytes;
    if (strlen($b) < 12) return '';
    if (substr($b, 0, 8) === "\x89PNG\r\n\x1a\n") return 'image/png';
    if (substr($b, 0, 3) === "\xff\xd8\xff") return 'image/jpeg';
    if (substr($b, 0, 6) === 'GIF87a' || substr($b, 0, 6) === 'GIF89a') return 'image/gif';
    if (substr($b, 0, 4) === 'RIFF' && substr($b, 8, 4) === 'WEBP') return 'image/webp';
    if (substr($b, 0, 2) === 'BM') return 'image/bmp';
    if (substr($b, 0, 4) === "\x00\x00\x01\x00") return 'image/x-icon';
    if (substr($b, 4, 4) === 'ftyp') {
        $brand = substr($b, 8, 4);
        if (strpos($brand, 'avif') !== false || strpos($brand, 'avis') !== false) return 'image/avif';
        if (strpos($brand, 'heic') !== false || strpos($brand, 'heix') !== false) return 'image/heic';
    }
    // SVG 是文本格式:必须是 XML/SVG 开头且不含 <script>(脚本由输出侧 CSP sandbox 再兜一层)
    $head = ltrim(substr($b, 0, 4096));
    if (stripos($head, '<svg') !== false || stripos($head, '<?xml') === 0) {
        if (stripos($head, '<script') === false) return 'image/svg+xml';
    }
    return '';
}

// 附件 id 编码归属:uidHexLen 前缀固定长度十六进制用户指纹,其余为随机段。
// serve 时无需查库即可定位目录,同时保证不同用户 id 空间不重叠。
function tc_note_file_owner_tag($userId) {
    return substr(hash_hmac('sha256', 'noteowner:' . (string) $userId, tc_secret()), 0, 13);
}

function tc_note_file_dir_for($id) {
    $id = (string) $id;
    if (strlen($id) < 14 || !preg_match('/^[a-f0-9]+$/', $id)) return '';
    $ownerTag = substr($id, 0, 13);
    $users = tc_notes_owner_index();
    $uid = isset($users[$ownerTag]) ? (string) $users[$ownerTag] : '';
    if ($uid === '') return '';
    return tc_note_user_dir($uid, false);
}

function tc_note_file_owner($fileId) {
    $idx = tc_notes_index_read();
    $tag = substr((string) $fileId, 0, 13);
    return isset($idx['owners'][$tag]) ? (string) $idx['owners'][$tag] : '';
}

function tc_note_file_bound_note($fileId) {
    $idx = tc_notes_index_read();
    return isset($idx['files'][$fileId]) ? (string) $idx['files'][$fileId] : '';
}

function tc_note_file_token($id) {
    return substr(hash_hmac('sha256', 'noteattach:' . (string) $id, tc_secret()), 0, 24);
}

function tc_note_file_path($id, $name = '') {
    $url = '/api/notes/file?id=' . rawurlencode((string) $id) . '&s=' . tc_note_file_token($id);
    if ($name !== '') $url .= '&name=' . rawurlencode((string) $name);
    return $url;
}

// Cookie 作用路径:子目录部署要带上目录前缀,否则浏览器不会在
// /subdir/api/notes/file 这样的请求上带它。
function tc_note_attach_cookie_path() {
    $script = str_replace('\\', '/', dirname(isset($_SERVER['SCRIPT_NAME']) ? $_SERVER['SCRIPT_NAME'] : '/'));
    $script = rtrim($script, '/');
    if ($script === '' || $script === '.' || $script === '/') return '/api/notes/file';
    return $script . '/api/notes/file';
}

function tc_note_attach_cookie_issue($db, $user) {
    $days = isset($db['settings']['sessionDays']) ? max(1, (int) $db['settings']['sessionDays']) : 7;
    $token = tc_jwt_sign(array(
        'scope' => 'noteattach',
        'sub' => (string) $user['id'],
        'tv' => isset($user['tv']) ? (int) $user['tv'] : 0,
        'ep' => isset($db['settings']['authEpoch']) ? max(1, (int) $db['settings']['authEpoch']) : 1,
        'exp' => tc_now() + $days * 24 * 3600 * 1000,
    ));
    $opts = array(
        'expires' => time() + $days * 24 * 3600,
        'path' => tc_note_attach_cookie_path(),
        'httponly' => true,
        'samesite' => 'Lax',
    );
    // Secure 只在 HTTPS 下加:免费主机常见 http 直连,写死 Secure 会让 Cookie 根本存不下来
    if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') $opts['secure'] = true;
    @setcookie(TC_NOTE_ATTACH_COOKIE, $token, $opts);
}

// 校验附件 Cookie,返回用户 ID(无效返回 '')
function tc_note_attach_cookie_uid($db) {
    $raw = isset($_COOKIE[TC_NOTE_ATTACH_COOKIE]) ? (string) $_COOKIE[TC_NOTE_ATTACH_COOKIE] : '';
    if ($raw === '') return '';
    $payload = tc_jwt_verify($raw);
    if (!$payload || !isset($payload['scope']) || (string) $payload['scope'] !== 'noteattach') return '';
    if (empty($payload['sub']) || empty($payload['exp']) || $payload['exp'] < tc_now()) return '';
    // 失效规则与会话令牌一致:改密码/重置会话(tv)、全站会话纪元(authEpoch)都会让它作废
    $epoch = isset($db['settings']['authEpoch']) ? (int) $db['settings']['authEpoch'] : 1;
    $payloadEpoch = isset($payload['ep']) ? (int) $payload['ep'] : 1;
    if ($payloadEpoch !== $epoch) return '';
    foreach ($db['users'] as $u) {
        if ((string) $u['id'] !== (string) $payload['sub']) continue;
        $tv = isset($u['tv']) ? (int) $u['tv'] : 0;
        $ptv = isset($payload['tv']) ? (int) $payload['tv'] : 0;
        return $ptv === $tv ? (string) $u['id'] : '';
    }
    return '';
}

// 已有同用户的有效 Cookie 就不重复下发,免得每个接口响应都挂一条 Set-Cookie
function tc_note_attach_cookie_sync($db, $user) {
    if (headers_sent()) return;
    if (tc_note_attach_cookie_uid($db) === (string) $user['id']) return;
    tc_note_attach_cookie_issue($db, $user);
}

function tc_note_attach_cookie_clear() {
    if (headers_sent()) return;
    @setcookie(TC_NOTE_ATTACH_COOKIE, '', array(
        'expires' => time() - 3600,
        'path' => tc_note_attach_cookie_path(),
        'httponly' => true,
        'samesite' => 'Lax',
    ));
}


// ============ 后台设置:笔记 AI 动作配置(设置文档清理时调用) ============

// 笔记 AI 动作配置:{disabled:[key], custom:[{key,label,desc,prompt}], overrides:{key:{label,desc,prompt}}}
function tc_settings_notes_ai_cfg($raw) {
    $out = array('disabled' => array(), 'custom' => array(), 'overrides' => array());
    if (!is_array($raw)) return $out;
    $rawDisabled = isset($raw['disabled']) && is_array($raw['disabled']) ? $raw['disabled'] : array();
    foreach (array_slice($rawDisabled, 0, 60) as $k) {
        $k = tc_settings_text($k, 64);
        if ($k !== '') $out['disabled'][] = $k;
    }
    $action = function ($row) {
        if (!is_array($row)) return null;
        $key = tc_settings_text(isset($row['key']) ? $row['key'] : '', 64);
        if ($key === '') return null;
        return array(
            'key' => $key,
            'label' => tc_settings_text(isset($row['label']) ? $row['label'] : '', 40),
            'desc' => tc_settings_text(isset($row['desc']) ? $row['desc'] : '', 120),
            'prompt' => tc_settings_text(isset($row['prompt']) ? $row['prompt'] : '', 8000),
        );
    };
    $rawCustom = isset($raw['custom']) && is_array($raw['custom']) ? $raw['custom'] : array();
    foreach (array_slice($rawCustom, 0, 40) as $row) {
        $a = $action($row);
        if ($a !== null) $out['custom'][] = $a;
    }
    $rawOv = isset($raw['overrides']) && is_array($raw['overrides']) ? $raw['overrides'] : array();
    $n = 0;
    foreach ($rawOv as $key => $row) {
        if (++$n > 60) break;
        $key = tc_settings_text($key, 64);
        if ($key === '' || !is_array($row)) continue;
        $out['overrides'][$key] = array(
            'label' => tc_settings_text(isset($row['label']) ? $row['label'] : '', 40),
            'desc' => tc_settings_text(isset($row['desc']) ? $row['desc'] : '', 120),
            'prompt' => tc_settings_text(isset($row['prompt']) ? $row['prompt'] : '', 8000),
        );
    }
    return $out;
}


// ============ 笔记同步与云端版本历史 ============

// GET /api/sync/notes:拉取当前用户笔记文档 + 修订号 + 分享状态(分享状态以服务端为准)
function tc_api_notes_get() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        tc_note_feature_guard($db, $user);
        tc_json(200, array(
            'doc' => tc_sanitize_notes_doc(tc_notes_of($db, $user['id'])),
            'revision' => tc_notes_revision_of($db, $user['id']),
            'shares' => tc_note_shares_of($db, $user['id']),
        ));
    });
}

// POST /api/sync/notes:整文档推送(baseRevision 乐观并发;冲突时 409 带回云端文档)
function tc_api_notes_save() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        tc_note_feature_guard($db, $user);
        if (!tc_rate_limit_check('notesync:' . $user['id'], 60)) {
            tc_fail(429, '同步过于频繁，请稍后再试');
        }
        $b = tc_read_json_body(8 * 1024 * 1024);
        $current = tc_notes_revision_of($db, $user['id']);
        $base = isset($b['baseRevision']) ? (int) $b['baseRevision'] : $current;
        if ($base !== $current) {
            tc_json(409, array(
                'error' => array('message' => '笔记已在其他页面更新'),
                'doc' => tc_sanitize_notes_doc(tc_notes_of($db, $user['id'])),
                'revision' => $current,
                'shares' => tc_note_shares_of($db, $user['id']),
            ));
        }
        $doc = tc_sanitize_notes_doc(isset($b['doc']) ? $b['doc'] : array());
        tc_set_notes($db, $user['id'], $doc);
        tc_json(200, array('ok' => true, 'revision' => tc_notes_revision_of($db, $user['id'])));
    });
}

function tc_note_versions_of(&$db, $userId) {
    $map = tc_assoc(isset($db['userNoteVersions']) ? $db['userNoteVersions'] : null);
    $db['userNoteVersions'] = tc_object_map($map);
    $doc = isset($map[$userId]) && is_array($map[$userId]) ? $map[$userId] : array();
    return is_array($doc) ? $doc : array();
}

function tc_note_versions_put(&$db, $userId, $doc) {
    $map = tc_assoc(isset($db['userNoteVersions']) ? $db['userNoteVersions'] : null);
    $map[$userId] = $doc;
    $db['userNoteVersions'] = tc_object_map($map);
}

// POST /api/notes/versions {noteId, content, updatedAt}:推一份快照(幂等去重 + 合并窗口)
function tc_api_note_versions_push() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        tc_note_feature_guard($db, $user);
        if (!tc_rate_limit_check('notever:' . $user['id'], 120, 60000)) {
            tc_fail(429, '操作过于频繁，请稍后再试');
        }
        $b = tc_read_json_body(64 * 1024);
        $noteId = substr(trim((string) (isset($b['noteId']) ? $b['noteId'] : '')), 0, 64);
        $content = (string) (isset($b['content']) ? $b['content'] : '');
        $updatedAt = (float) (isset($b['updatedAt']) ? $b['updatedAt'] : tc_now());
        if ($noteId === '' || $content === '') tc_json(200, array('ok' => true, 'skipped' => 'empty'));
        $doc = tc_note_versions_of($db, $user['id']);
        $items = isset($doc[$noteId]) && is_array($doc[$noteId]) ? $doc[$noteId] : array();
        $clip = function_exists('mb_substr') ? mb_substr($content, 0, TC_NOTE_VERSION_SNAPSHOT_BYTES, 'UTF-8') : substr($content, 0, TC_NOTE_VERSION_SNAPSHOT_BYTES);
        $now = tc_now();
        if ($items) {
            $last = $items[count($items) - 1];
            // 内容没变不重复存
            if ((string) ($last['c'] ?? '') === $clip) {
                $items[count($items) - 1]['t'] = (float) ($updatedAt ?: ($last['t'] ?? $now));
                $doc[$noteId] = $items;
                tc_note_versions_put($db, $user['id'], $doc);
                tc_json(200, array('ok' => true, 'kept' => true, 'count' => count($items)));
            }
            // 5 分钟内的连续保存合并为一份
            if ($now - (float) ($last['t'] ?? 0) < TC_NOTE_VERSION_MERGE_MS) {
                $items[count($items) - 1] = array('t' => $updatedAt ?: $now, 'c' => $clip);
                $doc[$noteId] = $items;
                tc_note_versions_put($db, $user['id'], $doc);
                tc_json(200, array('ok' => true, 'merged' => true, 'count' => count($items)));
            }
        }
        $items[] = array('t' => $updatedAt ?: $now, 'c' => $clip);
        if (count($items) > TC_NOTE_VERSIONS_CAP) $items = array_slice($items, -TC_NOTE_VERSIONS_CAP);
        $doc[$noteId] = $items;
        tc_note_versions_put($db, $user['id'], $doc);
        tc_json(200, array('ok' => true, 'count' => count($items)));
    });
}

// GET /api/notes/versions?noteId=:取某笔记的云端快照列表(旧→新)
function tc_api_note_versions_list() {
    tc_with_db(false, function ($db) {
        $user = tc_require_auth($db);
        tc_note_feature_guard($db, $user);
        $q = tc_query();
        $noteId = substr(trim((string) (isset($q['noteId']) ? $q['noteId'] : '')), 0, 64);
        $doc = tc_note_versions_of($db, $user['id']);
        $items = ($noteId !== '' && isset($doc[$noteId]) && is_array($doc[$noteId])) ? $doc[$noteId] : array();
        $out = array();
        foreach ($items as $it) {
            $out[] = array('t' => (float) (isset($it['t']) ? $it['t'] : 0), 'content' => (string) (isset($it['c']) ? $it['c'] : ''));
        }
        tc_json(200, array('items' => $out));
    });
}


// ============ 附件 ============

// POST /api/notes/upload:multipart 附件上传(图片 + 常见文档),返回签名 URL
function tc_api_note_attachment_upload() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        tc_note_feature_guard($db, $user);
        if (!tc_rate_limit_check('noteupload:' . $user['id'], 60, 3600000)) {
            tc_fail(429, '上传过于频繁，请稍后再试');
        }
        if (empty($_FILES['file']) || !is_array($_FILES['file'])) tc_fail(400, '缺少上传文件');
        $f = $_FILES['file'];
        $err = (int) (isset($f['error']) ? $f['error'] : 0);
        if ($err !== UPLOAD_ERR_OK || empty($f['tmp_name']) || !is_uploaded_file($f['tmp_name'])) {
            tc_fail(400, $err === UPLOAD_ERR_INI_SIZE ? '文件超过服务器上传上限' : '上传失败（错误码 ' . $err . '）');
        }
        $name = trim((string) (isset($f['name']) ? $f['name'] : ''));
        $name = str_replace(array("\r", "\n", '/', '\\'), '', $name !== '' ? $name : 'file');
        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        // 通用文件上传:图片与常见文档用白名单给准确 MIME,其余一律放行(download),
        // 但强制经签名路由 + Content-Disposition: attachment 输出,浏览器不内联执行,
        // 因此不会把本站变成可托管恶意 HTML/脚本的图床。
        $images = array(
            'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg',
            'gif' => 'image/gif', 'webp' => 'image/webp', 'svg' => 'image/svg+xml',
            'bmp' => 'image/bmp', 'ico' => 'image/x-icon', 'avif' => 'image/avif',
        );
        $docs = array(
            'pdf' => 'application/pdf', 'txt' => 'text/plain', 'md' => 'text/markdown',
            'csv' => 'text/csv', 'json' => 'application/json', 'zip' => 'application/zip',
            'gz' => 'application/gzip', '7z' => 'application/x-7z-compressed',
            'rar' => 'application/vnd.rar', 'tar' => 'application/x-tar',
            'doc' => 'application/msword',
            'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'xls' => 'application/vnd.ms-excel',
            'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'ppt' => 'application/vnd.ms-powerpoint',
            'pptx' => 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'mp3' => 'audio/mpeg', 'wav' => 'audio/wav', 'm4a' => 'audio/mp4',
            'mp4' => 'video/mp4', 'webm' => 'video/webm',
        );
        if ($ext === '') tc_fail(400, '文件缺少扩展名，无法识别类型');
        if (!isset($images[$ext]) && isset($db['settings']['notesAllowFiles']) && !$db['settings']['notesAllowFiles']) {
            tc_fail(403, '本站仅允许上传图片附件');
        }
        $isImage = isset($images[$ext]);
        $mime = $isImage ? $images[$ext] : (isset($docs[$ext]) ? $docs[$ext] : 'application/octet-stream');
        $sniffed = '';
        // 单文件上限:图片按后台 notesMaxImageMb(默认 10MB);其余按 notesMaxFileMb
        $fileMb = isset($db['settings']['notesMaxFileMb']) ? (int) $db['settings']['notesMaxFileMb'] : 50;
        if ($fileMb <= 0) $fileMb = 50;
        $imgMb = isset($db['settings']['notesMaxImageMb']) ? (int) $db['settings']['notesMaxImageMb'] : 10;
        if ($imgMb <= 0) $imgMb = 10;
        $max = ($isImage ? $imgMb : $fileMb) * 1048576;
        $size = (int) (isset($f['size']) ? $f['size'] : 0);
        if ($size <= 0 || $size > $max) tc_fail(400, '文件大小超出限制（' . round($max / 1048576) . 'MB）');
        // 用户空间配额(0=不限):先按已用量 + 本次大小判断,避免超限写入
        $quota = tc_note_quota_bytes($db);
        if ($quota > 0 && tc_note_user_usage($user['id']) + $size > $quota) {
            tc_fail(413, '笔记空间不足，请清理附件或联系管理员调整上限');
        }
        // 只读前 64KB 做魔数校验:校验器最多看 4096 字节,没必要把整个附件读进内存
        $fh = @fopen($f['tmp_name'], 'rb');
        if (!$fh) tc_fail(400, '文件读取失败');
        $probe = (string) fread($fh, 65536);
        if (strlen($probe) === 0) { fclose($fh); tc_fail(400, '文件读取不完整'); }
        // 图片必须通过魔数校验:防止把 HTML/脚本改名成 .png 当成图片内联输出
        if ($isImage) {
            $sniffed = tc_note_sniff_image_mime($probe);
            if ($sniffed === '') {
                fclose($fh);
                tc_fail(400, '文件内容与图片格式不符（伪造扩展名？），请上传真实的图片文件');
            }
            $mime = $sniffed;
            // 扩展名声明为 svg 时必须真是 svg,反之亦然(避免 png 头配 .svg 扩展名)
            if (($ext === 'svg') !== ($sniffed === 'image/svg+xml')) {
                fclose($fh);
                tc_fail(400, '文件内容与扩展名不一致，请检查文件');
            }
        }
        unset($probe);
        $dir = tc_note_user_dir($user['id']);
        if ($dir === '' || !is_dir($dir) || !is_writable($dir)) { fclose($fh); tc_fail(500, '附件目录不可写，请检查 data/ 目录权限'); }
        // 归属声明:前端上传时带上目标笔记 id(未带则视为未绑定,只能属主本人访问)
        $boundNoteId = substr(trim((string) (isset($_POST['noteId']) ? $_POST['noteId'] : '')), 0, 64);
        tc_notes_index_add($user['id'], '', '');
        // id = 用户指纹(13) + 随机段:serve 时据指纹定位目录,实现归属隔离
        $id = tc_note_file_owner_tag($user['id']) . tc_uid(11);
        tc_notes_index_add($user['id'], $id, $boundNoteId);
        // 流式写入:先写头部(长度 + MIME),再把临时文件原样拷过去。
        // 旧实现是 $head . $body,意味着正文在内存里被复制一份(50MB 附件 = 100MB 峰值),
        // 大附件在 memory_limit 较低的主机上直接 500。
        $outPath = $dir . '/' . $id . '.bin';
        $tmpOut = $dir . '/' . $id . '.part';
        $w = @fopen($tmpOut, 'wb');
        if (!$w) { fclose($fh); tc_fail(500, '附件保存失败'); }
        $ct = $mime;
        $head = chr(strlen($ct)) . $ct;
        $ok = (fwrite($w, $head) === strlen($head));
        if ($ok) {
            fseek($fh, 0);
            while (!feof($fh)) {
                $buf = fread($fh, 262144);
                if ($buf === false || $buf === '') break;
                if (fwrite($w, $buf) === false) { $ok = false; break; }
            }
        }
        fclose($fh);
        fflush($w);
        fclose($w);
        if (!$ok || (int) @filesize($tmpOut) !== strlen($head) + $size) {
            @unlink($tmpOut);
            tc_fail(500, '附件保存失败');
        }
        // 先写 .part 再改名:避免并发读取到只写了一半的文件
        if (!@rename($tmpOut, $outPath)) {
            @unlink($tmpOut);
            tc_fail(500, '附件保存失败');
        }
        tc_json(200, array(
            'id' => $id,
            'name' => $name,
            'mimeType' => $mime,
            'size' => $size,
            'url' => tc_note_file_path($id, $name),
            'createdAt' => tc_now(),
            'used' => tc_note_user_usage($user['id']),
            'quota' => $quota,
        ));
    });
}

// DELETE /api/notes/file?id=:删除自己的附件(随笔记删除一起调用),释放配额并清理索引
function tc_api_note_attachment_delete() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        $q = tc_query();
        $id = preg_replace('/[^a-f0-9]/', '', (string) (isset($q['id']) ? $q['id'] : ''));
        if ($id === '') tc_fail(400, '缺少附件 ID');
        // 只能删自己的:按 id 归属指纹判定
        $owner = tc_note_file_owner($id);
        if ($owner === '') {
            // 索引里没有(可能是历史遗留):按目录归属兜底
            $dir = tc_note_file_dir_for($id);
            $owner = $dir === '' ? '' : basename($dir);
        }
        if ($owner === '' || (string) $owner !== (string) $user['id']) {
            tc_fail(404, '附件不存在');
        }
        $dir = tc_note_user_dir($user['id'], false);
        $f = $dir !== '' ? $dir . '/' . $id . '.bin' : '';
        $removed = false;
        if ($f !== '' && is_file($f)) $removed = @unlink($f);
        tc_notes_index_remove_file($id);
        tc_json(200, array('ok' => true, 'removed' => $removed, 'used' => tc_note_user_usage($user['id'])));
    });
}

// POST /api/notes/files/gc:回收孤儿附件(不再被任何笔记引用的文件),释放配额。
// 客户端在同步完成后调用:服务端以「现存笔记的 attachments」为准做对账。
function tc_api_note_attachments_gc() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        tc_note_feature_guard($db, $user);
        if (!tc_rate_limit_check('notegc:' . $user['id'], 12, 3600000)) {
            tc_fail(429, '回收操作过于频繁，请稍后再试');
        }
        $doc = tc_notes_of($db, $user['id']);
        $alive = array();
        foreach ((array) ($doc['notes'] ?? array()) as $n) {
            if (!is_array($n)) continue;
            foreach ((array) ($n['attachments'] ?? array()) as $a) {
                if (is_array($a) && !empty($a['id'])) $alive[(string) $a['id']] = true;
            }
        }
        $dir = tc_note_user_dir($user['id'], false);
        $removed = 0;
        $freed = 0;
        if ($dir !== '' && is_dir($dir)) {
            foreach ((array) @glob($dir . '/*.bin') as $f) {
                $fid = basename($f, '.bin');
                if (isset($alive[$fid])) continue;
                $sz = (int) @filesize($f);
                if (@unlink($f)) { $removed++; $freed += $sz; tc_notes_index_remove_file($fid); }
            }
            // 上传中断会留下 .part 半成品(不是合法附件,也不会被上面扫到),顺手清掉旧的
            foreach ((array) @glob($dir . '/*.part') as $f) {
                if (@filemtime($f) > time() - 3600) continue;   // 可能还有正在进行的上传
                if (@unlink($f)) $removed++;
            }
        }
        tc_json(200, array('ok' => true, 'removed' => $removed, 'freed' => $freed, 'used' => tc_note_user_usage($user['id'])));
    });
}

// GET /api/notes/file?id=&s=:签名鉴权输出附件。
// data/ 整目录禁网,必须经此路由;附件归属由 id 前缀指纹定位到 data/notes/{uid}/,
// 即「仅笔记所属人能读到自己的文件」;非图片一律 Content-Disposition: attachment
// 强制下载(避免被当作 HTML/脚本外链托管),SVG 另加 CSP sandbox。
// 「本人」的判定同时认两种凭据:Bearer 请求头(前端接口调用)与附件 Cookie
// (浏览器加载正文里的 <img>/<a> 时带不了请求头,见 tc_note_attach_cookie_uid)。
function tc_api_note_attachment_serve() {
    $q = tc_query();
    $id = preg_replace('/[^a-f0-9]/', '', (string) (isset($q['id']) ? $q['id'] : ''));
    $sig = (string) (isset($q['s']) ? $q['s'] : '');
    if ($id === '' || $sig === '' || !hash_equals(tc_note_file_token($id), $sig)) {
        http_response_code(403);
        header('Content-Type: text/plain; charset=utf-8');
        echo '签名无效';
        exit;
    }
    // ---- 身份鉴权:签名只证明「链接格式正确」,不代表「有权访问」----
    // 默认只有附件所属人本人可下载(复制链接给他人、未登录访问一律 404,不暴露存在性)。
    // 唯一例外:该附件所属笔记已开启分享,且管理员关闭了「分享仅包含正文」时,
    // 持该笔记分享令牌(share 参数)者可下载——即「通过分享的笔记下载」。
    $ownerId = tc_note_file_owner($id);
    $boundNote = tc_note_file_bound_note($id);
    $shareToken = (string) (isset($q['share']) ? $q['share'] : '');
    $allowed = false;
    if ($ownerId !== '') {
        tc_with_db(false, function ($db) use (&$allowed, $ownerId, $boundNote, $shareToken) {
            $me = tc_auth_user($db);
            if ($me && (string) $me['id'] === $ownerId) { $allowed = true; return; }
            // 正文里的 <img>/<a> 是浏览器自发请求,带不了 Authorization 头,认附件 Cookie
            if (tc_note_attach_cookie_uid($db) === $ownerId) { $allowed = true; return; }
            if ($shareToken === '' || $boundNote === '') return;
            $share = tc_note_share_find($db, $shareToken);
            if (!$share || (string) $share['ownerId'] !== $ownerId) return;
            if ((string) $share['noteId'] !== $boundNote) return;
            $bodyOnly = !array_key_exists('notesShareBodyOnly', $db['settings']) || !empty($db['settings']['notesShareBodyOnly']);
            if (!$bodyOnly) $allowed = true;
        });
    }
    if (!$allowed) {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo '附件不存在';
        exit;
    }
    $dir = tc_note_file_dir_for($id);
    $f = $dir !== '' ? $dir . '/' . $id . '.bin' : '';
    if ($f === '' || !is_file($f)) {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo '附件不存在';
        exit;
    }
    $raw = (string) @file_get_contents($f);
    if (strlen($raw) < 2) {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo '附件不存在';
        exit;
    }
    $len = ord($raw[0]);
    $ctype = substr($raw, 1, $len);
    $bodyLen = strlen($raw) - 1 - $len;
    unset($raw);   // 下面改为分块转发,不要同时在内存里留一份完整副本
    if ($ctype === '' || strpos($ctype, '/') === false) $ctype = 'application/octet-stream';
    $isImage = strpos($ctype, 'image/') === 0;
    header('Content-Type: ' . $ctype);
    header('Content-Length: ' . $bodyLen);
    header('X-Content-Type-Options: nosniff');
    if ($isImage) {
        // 图片:允许内联(笔记预览与分享页都要看图);SVG 用 CSP sandbox 阻断脚本
        if ($ctype === 'image/svg+xml') {
            header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
        }
    } else {
        // 其它一切类型:强制下载,不内联渲染,避免变成可托管网页/脚本的外链
        // (不用正则清洗:字符类里的转义容易写坏,直接按字符过滤更稳)
        $name = isset($q['name']) ? str_replace(array("\r", "\n", '"', '\\', '/'), '', (string) $q['name']) : '';
        $name = trim(substr($name, 0, 160));
        if ($name === '') $name = 'download';
        header("Content-Disposition: attachment; filename=\"" . rawurlencode($name) . "\"; filename*=UTF-8''" . rawurlencode($name));
        header("Content-Security-Policy: default-src 'none'; sandbox");
    }
    header('Cache-Control: private, max-age=31536000, immutable');
    // 分块转发正文:200MB 上限的附件整份读进内存会撞 PHP memory_limit,
    // 而这里只需要把「文件第 1+len 字节之后的部分」原样送出。
    $fp = @fopen($f, 'rb');
    if (!$fp) { echo ''; exit; }
    fseek($fp, 1 + $len);
    while (!feof($fp)) {
        $chunk = fread($fp, 262144);
        if ($chunk === false || $chunk === '') break;
        echo $chunk;
        if (function_exists('ob_flush')) @ob_flush();
        flush();
    }
    fclose($fp);
    exit;
}


// ============ 分享与访客留言 ============

function tc_note_shares_of($db, $userId) {
    $out = array();
    foreach (tc_assoc(isset($db['noteShares']) ? $db['noteShares'] : array()) as $s) {
        if (!is_array($s) || (string) ($s['ownerId'] ?? '') !== (string) $userId) continue;
        $out[] = array(
            'noteId' => (string) ($s['noteId'] ?? ''),
            'token' => (string) ($s['token'] ?? ''),
            'mode' => (string) ($s['mode'] ?? 'view-link'),
            'createdAt' => (float) ($s['createdAt'] ?? 0),
            'expireAt' => (float) ($s['expireAt'] ?? 0),
        );
    }
    usort($out, function ($a, $b) { return ((int) $a['createdAt']) <=> ((int) $b['createdAt']); });
    return $out;
}

function tc_note_share_find($db, $token) {
    $map = tc_assoc(isset($db['noteShares']) ? $db['noteShares'] : array());
    $s = isset($map[(string) $token]) ? $map[(string) $token] : null;
    if (!is_array($s) || (string) ($s['token'] ?? '') !== (string) $token) return null;
    // 有效期:到期即视为不存在(链接自动失效,无需手动关闭)
    $exp = isset($s['expireAt']) ? (int) $s['expireAt'] : 0;
    if ($exp > 0 && tc_now() >= $exp) return null;
    return $s;
}

function tc_note_find_in_doc($doc, $noteId) {
    foreach ((array) ($doc['notes'] ?? array()) as $i => $n) {
        if (is_array($n) && (string) ($n['id'] ?? '') === (string) $noteId) return array($i, $n);
    }
    return array(-1, null);
}

// POST /api/notes/share:为笔记生成分享链接(同一笔记重复调用即重新生成,旧链接失效)
function tc_api_note_share_create() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        tc_note_feature_guard($db, $user);
        if (!tc_rate_limit_check('noteshare:' . $user['id'], 30, 3600000)) {
            tc_fail(429, '创建分享过于频繁，请稍后再试');
        }
        $b = tc_read_json_body();
        $noteId = substr(trim((string) (isset($b['noteId']) ? $b['noteId'] : '')), 0, 64);
        $mode = (string) (isset($b['mode']) ? $b['mode'] : 'view-link');
        if (!in_array($mode, array('view-link', 'edit-link'), true)) $mode = 'view-link';
        // 有效期:0=永久,其余为天数(1/7/30 等);过期后链接自动失效
        $expireDays = isset($b['expireDays']) ? (int) $b['expireDays'] : 0;
        if ($expireDays < 0) $expireDays = 0;
        if ($expireDays > 3650) $expireDays = 3650;
        $expireAt = $expireDays > 0 ? tc_now() + $expireDays * 86400000 : 0;
        if ($noteId === '') tc_fail(400, '缺少笔记 ID');
        $doc = tc_notes_of($db, $user['id']);
        list($idx, $note) = tc_note_find_in_doc($doc, $noteId);
        if ($idx < 0) tc_fail(404, '笔记不存在或已被删除');
        // 每用户最多 200 条分享:超出时轮出最早的一条(FIFO,同对话分享)
        $shares = tc_assoc(isset($db['noteShares']) ? $db['noteShares'] : array());
        $mine = array();
        foreach ($shares as $t => $s) {
            if ((string) ($s['ownerId'] ?? '') === (string) $user['id']) $mine[$t] = $s;
        }
        if (count($mine) >= 200) {
            uasort($mine, function ($x, $y) { return ((int) ($x['createdAt'] ?? 0)) <=> ((int) ($y['createdAt'] ?? 0)); });
            unset($shares[array_key_first($mine)]);
        }
        // 已有同笔记分享时:默认作废旧令牌(重新生成);
        // 前端传 keepToken=1 时保留令牌只更新权限与有效期(「已分享管理」里改设置用)
        $keepToken = !empty($b['keepToken']);
        $existToken = '';
        foreach ($mine as $t => $s) {
            if ((string) ($s['noteId'] ?? '') !== $noteId) continue;
            if ($keepToken) { $existToken = (string) $t; continue; }
            unset($shares[$t]);
        }
        $token = $existToken !== '' ? $existToken : tc_uid(9);
        // 分享页评论:属主可勾选允许访客留言;留言随分享记录存,属主可查看/清空
        $allowComments = !empty($b['allowComments']);
        $share = array(
            'token' => $token,
            'ownerId' => $user['id'],
            'noteId' => $noteId,
            'mode' => $mode,
            'createdAt' => tc_now(),
            'expireAt' => $expireAt,
            'allowComments' => $allowComments,
        );
        if (isset($shares[$token]) && is_array($shares[$token]) && isset($shares[$token]['comments'])) {
            // 保留旧令牌的既有留言(改设置场景);重新生成令牌则留言一并作废
            if ($keepToken) $share['comments'] = $shares[$token]['comments'];
        }
        $shares[$token] = $share;
        $db['noteShares'] = tc_object_map($shares);
        // 笔记本体同步分享状态(客户端展示用;权威状态始终以 noteShares 为准)
        $doc['notes'][$idx]['shareMode'] = $mode;
        $doc['notes'][$idx]['shareToken'] = $token;
        $doc['notes'][$idx]['updatedAt'] = (float) ($doc['notes'][$idx]['updatedAt'] ?? tc_now());
        $noteMap = tc_assoc(isset($db['userNotes']) ? $db['userNotes'] : array());
        $noteMap[$user['id']] = $doc;
        $db['userNotes'] = tc_object_map($noteMap);
        tc_json(200, array(
            'share' => array(
                'noteId' => $noteId, 'token' => $token, 'mode' => $mode,
                'createdAt' => (float) (isset($shares[$token]['createdAt']) ? $shares[$token]['createdAt'] : $share['createdAt']),
                'expireAt' => $expireAt, 'kept' => $existToken !== '',
                'allowComments' => $allowComments,
                'commentCount' => isset($share['comments']) && is_array($share['comments']) ? count($share['comments']) : 0,
            ),
            'url' => '/n/' . $token,
        ));
    });
}

// DELETE /api/notes/share:关闭分享(带 noteId),对应笔记的分享链接全部失效
function tc_api_note_share_close() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        $b = tc_read_json_body();
        $noteId = substr(trim((string) (isset($b['noteId']) ? $b['noteId'] : '')), 0, 64);
        if ($noteId === '') tc_fail(400, '缺少笔记 ID');
        $shares = tc_assoc(isset($db['noteShares']) ? $db['noteShares'] : array());
        foreach ($shares as $t => $s) {
            if ((string) ($s['ownerId'] ?? '') === (string) $user['id'] && (string) ($s['noteId'] ?? '') === $noteId) {
                unset($shares[$t]);
            }
        }
        $db['noteShares'] = tc_object_map($shares);
        $doc = tc_notes_of($db, $user['id']);
        list($idx, $note) = tc_note_find_in_doc($doc, $noteId);
        if ($idx >= 0) {
            $doc['notes'][$idx]['shareMode'] = 'private';
            $doc['notes'][$idx]['shareToken'] = '';
            $noteMap = tc_assoc(isset($db['userNotes']) ? $db['userNotes'] : array());
            $noteMap[$user['id']] = $doc;
            $db['userNotes'] = tc_object_map($noteMap);
        }
        tc_json(200, array('ok' => true));
    });
}

// 笔记的公开投影:不泄露属主与分享令牌以外的内部字段
// 把正文里的本站附件引用(图片/文件链接)替换为提示文字。
// 用于「分享仅包含正文」:分享出去的只是文字,不连带把附件文件也公开。
function tc_note_strip_file_links($md) {
    $md = (string) $md;
    // ![alt](/api/notes/file?...)
    $md = preg_replace('/!\[[^\]]*\]\(\/api\/notes\/file\?[^)\s]*\)/', '（图片未在分享中显示）', $md);
    // [text](/api/notes/file?...)
    $md = preg_replace('/\[([^\]]*)\]\(\/api\/notes\/file\?[^)\s]*\)/', '（附件《$1》未在分享中显示）', $md);
    return $md;
}

function tc_public_shared_note($note, $mode, $bodyOnly = true, $shareToken = '') {
    $content = (string) ($note['content'] ?? '');
    $out = array(
        'id' => (string) ($note['id'] ?? ''),
        'title' => (string) ($note['title'] ?? ''),
        'content' => $bodyOnly ? tc_note_strip_file_links($content) : $content,
        'tags' => array_values((array) ($note['tags'] ?? array())),
        'createdAt' => (float) ($note['createdAt'] ?? 0),
        'updatedAt' => (float) ($note['updatedAt'] ?? 0),
        'mode' => (string) $mode,
        'editable' => $mode === 'edit-link',
        'bodyOnly' => (bool) $bodyOnly,
    );
    if (!$bodyOnly) {
        // 关闭「仅正文」时,让分享页能取到正文里引用的附件:
        // 给本站附件链接补上 share 令牌(服务端校验该令牌确属本篇笔记)
        $content = (string) ($note['content'] ?? '');
        if ($shareToken !== '' && strpos($content, '/api/notes/file') !== false) {
            $content = preg_replace_callback('/\/api\/notes\/file\?([^)\s]*)/', function ($m) use ($shareToken) {
                return '/api/notes/file?' . $m[1] . '&share=' . rawurlencode($shareToken);
            }, $content);
        }
        $out['content'] = $content;
        $atts = array();
        foreach ((array) ($note['attachments'] ?? array()) as $at) {
            if (!is_array($at) || empty($at['url'])) continue;
            $atts[] = array(
                'name' => (string) ($at['name'] ?? 'file'),
                'url' => (string) $at['url'],
                'mimeType' => (string) ($at['mimeType'] ?? ''),
                'size' => (int) ($at['size'] ?? 0),
            );
        }
        $out['attachments'] = $atts;
    }
    return $out;
}

// GET /api/notes/shared/{token}:公开读取(实时取属主笔记,关闭分享即失效)
function tc_api_note_shared_get($token) {
    tc_with_db(false, function ($db) use ($token) {
        $share = tc_note_share_find($db, $token);
        if (!$share) tc_fail(404, '分享不存在或已失效');
        $doc = tc_notes_of($db, $share['ownerId']);
        list($idx, $note) = tc_note_find_in_doc($doc, $share['noteId']);
        if ($idx < 0) tc_fail(404, '笔记不存在或已被删除');
        $bodyOnly = !array_key_exists('notesShareBodyOnly', $db['settings']) || !empty($db['settings']['notesShareBodyOnly']);
        // 分享页评论:开启时把留言一并下发(访客可看可评)
        $comments = array();
        $allowComments = !empty($share['allowComments']);
        if ($allowComments && isset($share['comments']) && is_array($share['comments'])) {
            foreach ($share['comments'] as $c) {
                if (!is_array($c)) continue;
                $comments[] = array(
                    't' => (float) (isset($c['t']) ? $c['t'] : 0),
                    'name' => (string) (isset($c['name']) ? $c['name'] : '访客'),
                    'text' => (string) (isset($c['text']) ? $c['text'] : ''),
                );
            }
        }
        tc_json(200, array(
            'note' => tc_public_shared_note($note, (string) $share['mode'], $bodyOnly, (string) $token),
            'allowComments' => $allowComments,
            'comments' => $comments,
        ));
    });
}

// 分享页留言:访客无需登录,按 token 限流防灌水;留言随分享记录存,上限 100 条
function tc_api_note_shared_comment($token) {
    tc_with_db(true, function (&$db) use ($token) {
        if (!tc_rate_limit_check('notecmt:' . tc_client_ip(), 10, 3600000)) {
            tc_fail(429, '留言过于频繁，请稍后再试');
        }
        $b = tc_read_json_body();
        $text = trim((string) (isset($b['text']) ? $b['text'] : ''));
        $name = trim((string) (isset($b['name']) ? $b['name'] : ''));
        if ($text === '') tc_fail(400, '请填写留言内容');
        if (function_exists('mb_substr')) {
            $text = mb_substr($text, 0, 500, 'UTF-8');
            $name = $name !== '' ? mb_substr($name, 0, 40, 'UTF-8') : '访客';
        } else {
            $text = substr($text, 0, 500);
            $name = $name !== '' ? substr($name, 0, 40) : '访客';
        }
        $shares = tc_assoc(isset($db['noteShares']) ? $db['noteShares'] : array());
        $share = isset($shares[$token]) && is_array($shares[$token]) ? $shares[$token] : null;
        if (!$share) tc_fail(404, '分享不存在或已失效');
        if (!empty($share['expireAt']) && (int) $share['expireAt'] < tc_now()) tc_fail(404, '分享不存在或已失效');
        if (empty($share['allowComments'])) tc_fail(403, '作者未开放这篇笔记的留言');
        $comments = isset($share['comments']) && is_array($share['comments']) ? $share['comments'] : array();
        $comments[] = array('t' => tc_now(), 'name' => $name, 'text' => $text);
        if (count($comments) > 100) $comments = array_slice($comments, -100);
        $share['comments'] = $comments;
        $shares[$token] = $share;
        $db['noteShares'] = tc_object_map($shares);
        tc_json(200, array('ok' => true, 'comments' => array_map(function ($c) {
            return array('t' => (float) ($c['t'] ?? 0), 'name' => (string) ($c['name'] ?? '访客'), 'text' => (string) ($c['text'] ?? ''));
        }, $comments)));
    });
}

// 属主查看/清空某篇笔记分享的留言
function tc_api_note_share_comments() {
    tc_with_db(true, function (&$db) {
        $user = tc_require_auth($db);
        $q = tc_query();
        $noteId = substr(trim((string) (isset($q['noteId']) ? $q['noteId'] : '')), 0, 64);
        if ($noteId === '') tc_fail(400, '缺少笔记 ID');
        $shares = tc_assoc(isset($db['noteShares']) ? $db['noteShares'] : array());
        $share = null;
        $shareToken = '';
        foreach ($shares as $t => $s) {
            if ((string) ($s['ownerId'] ?? '') === (string) $user['id'] && (string) ($s['noteId'] ?? '') === $noteId) { $share = $s; $shareToken = (string) $t; break; }
        }
        if ($_SERVER['REQUEST_METHOD'] === 'DELETE') {
            if ($share) {
                $share['comments'] = array();
                $shares[$shareToken] = $share;
                $db['noteShares'] = tc_object_map($shares);
            }
            tc_json(200, array('ok' => true, 'comments' => array()));
        }
        $comments = array();
        if ($share && isset($share['comments']) && is_array($share['comments'])) {
            foreach ($share['comments'] as $c) {
                if (!is_array($c)) continue;
                $comments[] = array(
                    't' => (float) (isset($c['t']) ? $c['t'] : 0),
                    'name' => (string) (isset($c['name']) ? $c['name'] : '访客'),
                    'text' => (string) (isset($c['text']) ? $c['text'] : ''),
                );
            }
        }
        tc_json(200, array(
            'comments' => $comments,
            'allowComments' => $share ? !empty($share['allowComments']) : false,
            'token' => $shareToken,
        ));
    });
}


// ============ 后台管理:管理员查看与清理 ============

// ---- 管理端:笔记管理 ----
// GET /api/admin/notes:正在使用笔记的用户列表(笔记数/附件用量/最近更新),支持搜索
function tc_api_admin_notes_users() {
    tc_with_db(false, function ($db) {
        // 用户笔记属于个人内容,演示管理员不可查看(与「不可查看用户对话」一致)
        tc_demo_guard(tc_require_admin($db), '演示管理员不可查看用户笔记');
        $q = tc_query();
        $kw = strtolower(trim((string) (isset($q['q']) ? $q['q'] : '')));
        $quota = tc_note_quota_bytes($db);
        $map = tc_assoc(isset($db['userNotes']) ? $db['userNotes'] : array());
        $nameOf = array();
        foreach ($db['users'] as $u) {
            if (isset($u['id'])) $nameOf[(string) $u['id']] = (string) (isset($u['name']) ? $u['name'] : '');
        }
        $rows = array();
        foreach ($map as $uid => $doc) {
            $uid = (string) $uid;
            $notes = (isset($doc['notes']) && is_array($doc['notes'])) ? $doc['notes'] : array();
            if (!$notes && empty($doc['folders'])) continue;
            $name = isset($nameOf[$uid]) ? $nameOf[$uid] : ('#' . $uid);
            if ($kw !== '' && strpos(strtolower($name), $kw) === false && strpos(strtolower($uid), $kw) === false) continue;
            $latest = 0;
            $chars = 0;
            foreach ($notes as $n) {
                if (!is_array($n)) continue;
                $latest = max($latest, (int) (isset($n['updatedAt']) ? $n['updatedAt'] : 0));
                $chars += strlen((string) (isset($n['content']) ? $n['content'] : ''));
            }
            $folders = (isset($doc['folders']) && is_array($doc['folders'])) ? count($doc['folders']) : 0;
            $rows[] = array(
                'userId' => $uid,
                'name' => $name,
                'folders' => $folders,
                'notes' => count($notes),
                'chars' => $chars,
                'used' => tc_note_user_usage($uid),
                'latestAt' => $latest,
            );
        }
        usort($rows, function ($a, $b) { return ((int) $b['latestAt']) <=> ((int) $a['latestAt']); });
        tc_json(200, array(
            'users' => $rows,
            'quota' => $quota,
            'totalUsed' => array_sum(array_column($rows, 'used')),
            'notesTotal' => array_sum(array_column($rows, 'notes')),
        ));
    });
}

// GET /api/admin/notes/view?userId=:审阅某个用户的笔记(仅元数据 + 正文,不含附件二进制)
function tc_api_admin_notes_view() {
    tc_with_db(false, function ($db) {
        $admin = tc_require_admin($db);
        tc_demo_guard($admin, '演示管理员不可查看用户笔记');
        $q = tc_query();
        $uid = substr(trim((string) (isset($q['userId']) ? $q['userId'] : '')), 0, 64);
        if ($uid === '') tc_fail(400, '缺少用户 ID');
        $doc = tc_notes_of($db, $uid);
        $name = '';
        foreach ($db['users'] as $u) { if ((string) $u['id'] === $uid) { $name = (string) $u['name']; break; } }
        tc_log_auth_event('admin', isset($admin['name']) ? $admin['name'] : '', '查看用户笔记:' . ($name !== '' ? $name : $uid), isset($admin['id']) ? $admin['id'] : '');
        tc_json(200, array(
            'userId' => $uid,
            'name' => $name !== '' ? $name : ('#' . $uid),
            'folders' => (isset($doc['folders']) && is_array($doc['folders'])) ? $doc['folders'] : array(),
            'notes' => (isset($doc['notes']) && is_array($doc['notes'])) ? $doc['notes'] : array(),
            'used' => tc_note_user_usage($uid),
        ));
    });
}

// POST /api/admin/notes/purge:清空某用户的全部笔记数据(文档 + 附件文件)
function tc_api_admin_notes_purge() {
    tc_with_db(true, function (&$db) {
        $admin = tc_require_admin($db);
        if (tc_is_demo_user($admin)) tc_fail(403, '演示管理员不能清理用户笔记');
        $b = tc_read_json_body();
        $uid = substr(trim((string) (isset($b['userId']) ? $b['userId'] : '')), 0, 64);
        if ($uid === '') tc_fail(400, '缺少用户 ID');
        tc_drop_user_notes($db, $uid);
        $dir = tc_note_user_dir($uid, false);
        $removed = 0;
        if ($dir !== '' && is_dir($dir)) {
            foreach ((array) @glob($dir . '/*.bin') as $f) { if (@unlink($f)) $removed++; }
            foreach ((array) @glob($dir . '/*.part') as $f) { if (@unlink($f)) $removed++; }
            @rmdir($dir);
        }
        tc_log_auth_event('admin', isset($admin['name']) ? $admin['name'] : '', '清理用户笔记:' . $uid . '（' . $removed . ' 个附件）', isset($admin['id']) ? $admin['id'] : '');
        tc_json(200, array('ok' => true, 'removedFiles' => $removed));
    });
}
