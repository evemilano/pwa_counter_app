<?php
// Copia questo file in config.php e sostituisci il token con uno generato a mano:
//   openssl rand -hex 32
// config.php è in .gitignore — non finirà mai nel repo.

return [
    'token'     => 'CHANGE_ME_LONG_RANDOM_STRING',
    'data_file' => __DIR__ . '/data.php',
];
