<?php
// Counter PWA — sync endpoint
// GET  → returns { data, updatedAt, version }
// PUT  → body { data, expectedVersion } → { ok, version, updatedAt } or 409

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$configPath = __DIR__ . '/config.php';
if (!is_file($configPath)) {
    http_response_code(500);
    echo json_encode(['error' => 'Server not configured: missing config.php']);
    exit;
}
$config = require $configPath;
$token = $config['token'] ?? '';
$dataFile = $config['data_file'] ?? (__DIR__ . '/data.php');
$maxBodyBytes = 5 * 1024 * 1024;

$DATA_PREFIX = "<?php die(); ?>\n";

// --- Auth ---
$provided = trim((string)($_SERVER['HTTP_X_AUTH_TOKEN'] ?? ''));
if ($provided === '' && function_exists('getallheaders')) {
    foreach (getallheaders() as $k => $v) {
        if (strcasecmp($k, 'X-Auth-Token') === 0) { $provided = trim((string)$v); break; }
    }
}
if ($token === '' || $provided === '' || !hash_equals($token, $provided)) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

// --- Read state ---
function readState(string $dataFile, string $prefix): array {
    if (!is_file($dataFile)) return ['data' => null, 'updatedAt' => 0, 'version' => 0];
    $raw = file_get_contents($dataFile);
    if ($raw === false) return ['data' => null, 'updatedAt' => 0, 'version' => 0];
    if (str_starts_with($raw, $prefix)) $raw = substr($raw, strlen($prefix));
    $raw = trim($raw);
    if ($raw === '') return ['data' => null, 'updatedAt' => 0, 'version' => 0];
    $parsed = json_decode($raw, true);
    if (!is_array($parsed)) return ['data' => null, 'updatedAt' => 0, 'version' => 0];
    return [
        'data' => $parsed['data'] ?? null,
        'updatedAt' => (int)($parsed['updatedAt'] ?? 0),
        'version' => (int)($parsed['version'] ?? 0),
    ];
}

function writeState(string $dataFile, string $prefix, array $state): void {
    $json = json_encode($state, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json === false) {
        http_response_code(500);
        echo json_encode(['error' => 'Encode failure']);
        exit;
    }
    $tmp = $dataFile . '.tmp';
    $fh = @fopen($tmp, 'wb');
    if (!$fh) {
        http_response_code(500);
        echo json_encode(['error' => 'Cannot open data file for write']);
        exit;
    }
    fwrite($fh, $prefix . $json);
    fflush($fh);
    fclose($fh);
    if (!@rename($tmp, $dataFile)) {
        @unlink($tmp);
        http_response_code(500);
        echo json_encode(['error' => 'Cannot rename data file']);
        exit;
    }
    @chmod($dataFile, 0640);
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    $state = readState($dataFile, $DATA_PREFIX);
    echo json_encode($state);
    exit;
}

if ($method === 'PUT' || $method === 'POST') {
    $contentLength = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($contentLength > $maxBodyBytes) {
        http_response_code(413);
        echo json_encode(['error' => 'Payload too large']);
        exit;
    }
    $body = file_get_contents('php://input', false, null, 0, $maxBodyBytes + 1);
    if ($body === false || strlen($body) > $maxBodyBytes) {
        http_response_code(413);
        echo json_encode(['error' => 'Payload too large']);
        exit;
    }
    $payload = json_decode($body, true);
    if (!is_array($payload) || !array_key_exists('data', $payload) || !array_key_exists('expectedVersion', $payload)) {
        http_response_code(400);
        echo json_encode(['error' => 'Bad payload']);
        exit;
    }

    $current = readState($dataFile, $DATA_PREFIX);
    if ((int)$payload['expectedVersion'] !== $current['version']) {
        http_response_code(409);
        echo json_encode(['ok' => false, 'current' => $current]);
        exit;
    }

    $new = [
        'data' => $payload['data'],
        'updatedAt' => (int)round(microtime(true) * 1000),
        'version' => $current['version'] + 1,
    ];
    writeState($dataFile, $DATA_PREFIX, $new);
    echo json_encode(['ok' => true, 'version' => $new['version'], 'updatedAt' => $new['updatedAt']]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'Method not allowed']);
