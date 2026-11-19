<?php
/**
 * insights.php — 用量看板(后台「概览」里的成本 / 配额趋势)。
 *
 * 数据全在现成的两处,这里只做聚合,不新增写入:
 *   - stats.usageLedger{uid}{day}{model} = {calls, cost, prompt, completion}(tc_usage_rows 读的同一份)
 *   - 用户行上的 quota / quotaLedger(额度与逐笔流水)
 *
 * 与 tc_api_admin_stats 的分工:那个接口返回「今天怎么用」的看板摘要(总调用、额度排行),
 * 这里补的是「一段时间里花在谁身上、花在哪个模型上、还剩多少」——
 * 管理员要判断的其实是后者:该不该给某个模型降价、谁的额度该加、哪天真在烧钱。
 *
 * 演示管理员:一律匿名化(用户维度只给「用户 N」),与 stats 接口同一口径。
 */

// 把 usageLedger 摊平成按天 / 按模型两个维度的序列,并给出区间合计
function tc_insights_usage($db, $days) {
    $ledger = tc_assoc(isset($db['stats']['usageLedger']) ? $db['stats']['usageLedger'] : array());
    $byDay = array();
    $byModel = array();
    $byUser = array();
    foreach ($days as $d) $byDay[$d] = array('day' => $d, 'calls' => 0, 'cost' => 0.0, 'prompt' => 0, 'completion' => 0);
    foreach ($ledger as $uid => $rows) {
        foreach (tc_assoc($rows) as $day => $models) {
            if (!isset($byDay[$day])) continue;   // 窗口外的历史数据不计
            foreach (tc_assoc($models) as $model => $cell) {
                $cell = tc_assoc($cell);
                $calls = (int) (isset($cell['calls']) ? $cell['calls'] : 0);
                $cost = (float) (isset($cell['cost']) ? $cell['cost'] : 0);
                $prompt = (int) (isset($cell['prompt']) ? $cell['prompt'] : 0);
                $completion = (int) (isset($cell['completion']) ? $cell['completion'] : 0);
                $byDay[$day]['calls'] += $calls;
                $byDay[$day]['cost'] += $cost;
                $byDay[$day]['prompt'] += $prompt;
                $byDay[$day]['completion'] += $completion;
                $mk = (string) $model;
                if (!isset($byModel[$mk])) $byModel[$mk] = array('model' => $mk, 'calls' => 0, 'cost' => 0.0);
                $byModel[$mk]['calls'] += $calls;
                $byModel[$mk]['cost'] += $cost;
                $uk = (string) $uid;
                if (!isset($byUser[$uk])) $byUser[$uk] = array('userId' => $uk, 'calls' => 0, 'cost' => 0.0);
                $byUser[$uk]['calls'] += $calls;
                $byUser[$uk]['cost'] += $cost;
            }
        }
    }
    $models = array_values($byModel);
    usort($models, function ($a, $b) {
        if ($a['cost'] == $b['cost']) return $b['calls'] - $a['calls'];
        return ($a['cost'] < $b['cost']) ? 1 : -1;
    });
    $users = array_values($byUser);
    usort($users, function ($a, $b) {
        if ($a['cost'] == $b['cost']) return $b['calls'] - $a['calls'];
        return ($a['cost'] < $b['cost']) ? 1 : -1;
    });
    $total = array('calls' => 0, 'cost' => 0.0, 'prompt' => 0, 'completion' => 0);
    foreach ($byDay as $row) {
        $total['calls'] += $row['calls'];
        $total['cost'] += $row['cost'];
        $total['prompt'] += $row['prompt'];
        $total['completion'] += $row['completion'];
    }
    return array(
        'days' => array_values($byDay),
        'models' => array_slice($models, 0, 12),
        'users' => $users,
        'total' => $total,
    );
}

// 某账号的累计发放额度:额度流水里正数笔(amount>0)之和;没有流水时退回当前余额。
// 注意流水只保留最近 200 笔,所以这是「可追溯的下限」而不是精确总计 ——
// 看板的用途是横向比较谁在烧额度,不需要账面精确到分。
function tc_insights_quota_given($db, $userId, $fallback) {
    $ledger = isset($db['quotaLedger']) && is_array($db['quotaLedger']) ? $db['quotaLedger'] : array();
    $sum = 0.0;
    $any = false;
    foreach ($ledger as $r) {
        if (!is_array($r) || (string) (isset($r['userId']) ? $r['userId'] : '') !== (string) $userId) continue;
        $amt = isset($r['amount']) ? (float) $r['amount'] : 0;
        if ($amt > 0) { $sum += $amt; $any = true; }
    }
    return $any ? $sum : max(0, (float) $fallback);
}

// 额度侧:总量、已发、已用、剩余,以及「快用完」的账号数(便于提醒充值)
function tc_insights_quota($db) {
    $issued = 0.0;
    $left = 0.0;
    $unlimited = 0;
    $low = array();
    $lowThreshold = isset($db['settings']['quotaWarnBelow']) ? (int) $db['settings']['quotaWarnBelow'] : 0;
    foreach ((isset($db['users']) ? $db['users'] : array()) as $u) {
        if (empty($u['id'])) continue;
        if (!empty($u['admin']) || !empty($u['guest'])) continue;
        if (!empty($u['quotaUnlimited']) || (isset($u['quota']) && (string) $u['quota'] === '-1')) { $unlimited++; continue; }
        // 用户行上没有「累计发放」字段:以额度流水(quotaLedger)正数笔之和为准,
        // 没有流水的老账号退回「当前余额」(至少不会把已用量算成负数)
        $q = isset($u['quota']) ? (float) $u['quota'] : 0;
        $issued += tc_insights_quota_given($db, (string) $u['id'], $q);
        $left += max(0, $q);
        if ($lowThreshold > 0 && $q <= $lowThreshold) {
            $low[] = array(
                'id' => (string) $u['id'],
                'name' => isset($u['name']) ? (string) $u['name'] : '',
                'quota' => $q,
            );
        }
    }
    usort($low, function ($a, $b) { return $a['quota'] < $b['quota'] ? -1 : ($a['quota'] > $b['quota'] ? 1 : 0); });
    return array(
        'issued' => $issued,
        'remaining' => $left,
        'used' => max(0, $issued - $left),
        'unlimitedUsers' => $unlimited,
        'warnBelow' => $lowThreshold,
        'lowUsers' => array_slice($low, 0, 20),
        'lowCount' => count($low),
    );
}

// GET /api/admin/insights?days=14|30
function tc_api_admin_insights() {
    tc_with_db(false, function ($db) {
        $admin = tc_require_admin($db);
        $isDemo = tc_is_demo_user($admin);
        $q = tc_query();
        $span = isset($q['days']) ? (int) $q['days'] : 14;
        if (!in_array($span, array(7, 14, 30), true)) $span = 14;
        $days = tc_last_n_days($span);
        $usage = tc_insights_usage($db, $days);
        // 用户维度:演示管理员只看到匿名序号(与 stats 接口一致,不给可定位的 id)
        $names = array();
        foreach ($db['users'] as $u) if (isset($u['id'])) $names[(string) $u['id']] = isset($u['name']) ? (string) $u['name'] : '';
        $users = array();
        foreach ($usage['users'] as $i => $row) {
            $users[] = array(
                'id' => $isDemo ? 'demo-' . ($i + 1) : $row['userId'],
                'name' => $isDemo ? ('用户 ' . ($i + 1)) : (isset($names[$row['userId']]) && $names[$row['userId']] !== '' ? $names[$row['userId']] : '已删除用户'),
                'calls' => $row['calls'],
                'cost' => round($row['cost'], 4),
            );
        }
        $quota = tc_insights_quota($db);
        if ($isDemo) {
            $quota['lowUsers'] = array_map(function ($r, $i) {
                return array('id' => 'demo-' . ($i + 1), 'name' => '用户 ' . ($i + 1), 'quota' => $r['quota']);
            }, $quota['lowUsers'], array_keys($quota['lowUsers']));
        }
        tc_json(200, array(
            'days' => $span,
            'usage' => array(
                'series' => $usage['days'],
                'models' => $usage['models'],
                'users' => $users,
                'total' => array(
                    'calls' => $usage['total']['calls'],
                    'cost' => round($usage['total']['cost'], 4),
                    'prompt' => $usage['total']['prompt'],
                    'completion' => $usage['total']['completion'],
                ),
            ),
            'quota' => $quota,
        ));
    });
}
