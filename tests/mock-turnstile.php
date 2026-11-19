<?php
/**
 * E2E 测试用 mock Cloudflare Turnstile siteverify 端点。
 * 用法:php -S 127.0.0.1:8109 tests/mock-turnstile.php
 * 配合环境变量 TC_TURNSTILE_VERIFY_URL(见 tests/e2e.sh)把 siteverify 指向本服务。
 *
 * 按 response(token) 前缀返回不同结果,覆盖服务端全部判定路径:
 *   good…     → {"success":true}                       (服务端应放行)
 *   down…     → HTTP 500                               (服务端应 503 服务不可用,fail-closed)
 *   其他/缺失 → {"success":false,"error-codes":[…]}     (服务端应 403 人机验证未通过)
 * secret 必须等于 E2E 固定值 e2e-secret(否则 success:false):
 * 用于验证「掩码提交不覆盖已存 secret」—— 若提交把 secret 覆盖成掩码文本,good token 也会失败。
 */
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

function mj($data, $code = 200) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

$raw = (string) file_get_contents('php://input');
$b = array();
parse_str($raw, $b);
$token = isset($b['response']) ? (string) $b['response'] : '';
$secret = isset($b['secret']) ? (string) $b['secret'] : '';

if ($secret !== 'e2e-secret') mj(array('success' => false, 'error-codes' => array('invalid-input-secret')));
if (strpos($token, 'down') === 0) mj(array('error' => 'mock siteverify down'), 500);
if (strpos($token, 'good') === 0) mj(array('success' => true, 'challenge_ts' => gmdate('c')));
mj(array('success' => false, 'error-codes' => array('invalid-input-response')));
