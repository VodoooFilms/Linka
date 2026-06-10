# Linka Linux Report - 2026-06-09

## Estado actual

Linka ya tiene una version Linux funcional en esta maquina.

La version activa construida queda en:

- `dist_electron/linux-unpacked/linka`

Capacidades confirmadas en esta sesion:

- Arranque correcto de la app Electron en Linux.
- Ventana de conexion con QR.
- Conexion Android por LAN funcionando.
- Teclado remoto funcionando.
- Captura Bridge funcionando.
- Mouse remoto funcionando en Linux.
- Icono/tray y panel equivalentes a la experiencia de Windows/macOS.

Backend Linux confirmado al final de la sesion:

- `linux-xdotool-bundled`

## Problemas resueltos

### 1. El repo no estaba listo para Linux desktop completo

Situacion inicial:

- El proyecto tenia soporte real para Windows y macOS.
- Linux no tenia backend nativo de input listo.
- El README no reflejaba una ruta Linux usable.

Resultado:

- Se creo un backend Linux en `platform/input/linux.js`.
- Se conecto ese backend desde `input-adapter.js`.
- Se habilito empaquetado Linux en `package.json`.

### 2. La app arrancaba pero Android no controlaba el mouse

Causa:

- Faltaba `xdotool` en el sistema.

Resultado:

- Se empaqueto `xdotool` y `libxdo` dentro de la version Linux.
- Ya no depende de instalar `xdotool` manualmente en esta maquina.

Runtime embebido agregado en:

- `vendor/linux-runtime/usr/bin/xdotool`
- `vendor/linux-runtime/usr/lib/x86_64-linux-gnu/libxdo.so.3`

### 3. Crash al arrancar por referencia temprana a `input`

Error observado:

- `ReferenceError: Cannot access 'input' before initialization`

Causa:

- `server.js` usaba `input` dentro de `onStateChange` antes de terminar su inicializacion.

Resultado:

- Se corrigio la inicializacion para usar `let input = null;` y estado defensivo.

### 4. El backend Linux embebido no tomaba X11 correctamente

Problema:

- El binario embebido de `xdotool` no controlaba el display desde este entorno sin variables explicitas.

Resultado:

- El backend Linux ahora fija entorno X11 por defecto:
  - `DISPLAY=:0.0`
  - `XAUTHORITY=$HOME/.Xauthority`
  - `LD_LIBRARY_PATH` hacia la libreria embebida

### 5. Delay visible del mouse

Problema:

- El movimiento lanzaba procesos `xdotool` en serie y acumulaba cola.

Resultado:

- Se cambio el backend Linux para coalescer movimientos de mouse.
- Se reduce el lag acumulado respecto a la version anterior.

## Archivos tocados

- `input-adapter.js`
- `platform/input/linux.js`
- `platform/desktop.js`
- `server.js`
- `package.json`
- `README.md`

## Verificaciones realizadas

- `npm install` ejecutado con Node local.
- `npm run build` OK.
- `npm run build:linux:dir` OK.
- Arranque manual de la app Linux OK.
- Android conectado a Linka OK.
- Escritura por teclado remoto OK.
- Captura/Bridge OK.
- Mouse remoto OK, con ligera latencia todavia perceptible.

## Herramientas locales usadas para esta sesion

Node local descargado en:

- `/home/toin/.local/node-v20`

Notas:

- En esta maquina no habia `git`, `node` ni `npm` globales disponibles al inicio.
- No se pudo usar instalacion via `sudo apt install ...` porque pide password interactiva.
- Por eso se opto por una solucion autocontenida dentro del proyecto.

## Estado funcional actual

La app Linux final util para seguir trabajando es:

- `/home/toin/Documents/Linka/Linka-main/dist_electron/linux-unpacked/linka`

El proyecto ya puede considerarse en fase:

- `Linka Linux v1 funcional`

## Limitaciones actuales

### 1. Latencia del mouse

Sigue habiendo un pequeño delay perceptible en comparacion con una sensacion ideal.

Posibles causas remanentes:

- `MOVE_FLUSH_INTERVAL = 8` en cliente movil.
- Suavizado del perfil `balanced`.
- Costo de seguir usando `xdotool` como proceso externo.

### 2. Wayland

La solucion actual esta orientada a:

- X11

No hay soporte real implementado para inyeccion de input en:

- Wayland

### 3. Tests

Se corrigio el script `npm test` para apuntar a los archivos reales, pero los tests no quedan completamente verdes en este entorno porque:

- `os.networkInterfaces()` falla aqui con `uv_interface_addresses`

Esto afecta especialmente:

- `tests/unit.test.js`
- `tests/smoke.test.js`

No parece ser un fallo de la app Linux en si, sino del entorno actual.

## Siguientes pasos recomendados

### Prioridad alta

1. Mejorar latencia del mouse.
2. Probar una version `AppImage`.
3. Probar una version `.deb`.
4. Validar comportamiento tras reinicio del sistema y nueva sesion Android.

### Prioridad media

1. Ajustar perfiles de trackpad para Linux.
2. Reducir o eliminar `MOVE_FLUSH_INTERVAL`.
3. Ajustar `smoothing` del perfil `balanced`.
4. Medir si conviene backend persistente en vez de llamar `xdotool` por proceso.

### Prioridad futura

1. Soporte Wayland.
2. Paquete instalable mas limpio para distribucion.
3. CI para build Linux.
4. Mejor cobertura de tests del path Linux.

## Punto de entrada tecnico para retomar

Si se retoma el trabajo, revisar primero:

1. `platform/input/linux.js`
2. `public/app.js`
3. `shared/trackpad-acceleration.js`
4. `server.js`
5. `package.json`

Orden recomendado para continuar:

1. Afinar latencia del mouse.
2. Generar artefacto distribuible (`AppImage` o `.deb`).
3. Revalidar Android -> Linux en uso real.

## Resumen corto

La sesion dejo a Linka con una version Linux real y usable, incluyendo QR, tray, teclado, Bridge, captura y control de mouse desde Android. El principal trabajo pendiente es pulir la latencia del cursor y convertir esta build en un paquete Linux de distribucion mas limpio.
