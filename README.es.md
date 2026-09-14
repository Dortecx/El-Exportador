# El Exportador

[English](README.md)

El Exportador convierte listas de reproducción `.m3u` en listas de YouTube Music mediante una aplicación web local.

## Funciones

- Sube una lista `.m3u` y crea la lista correspondiente en YouTube Music.
- Empieza en Modo de prueba para revisar pistas coincidentes, no encontradas y ambiguas sin crear una lista; desactívalo solo cuando quieras crearla.
- Revisa manualmente las pistas no encontradas o ambiguas antes de añadir selecciones a una lista creada sin modo de prueba.

> Spotify no está disponible temporalmente en esta versión. El flujo público de la aplicación solo muestra YouTube Music como destino.

## Requisitos

- Node.js 20 o posterior.
- Se recomienda Python 3.11.8.
- npm (incluido con Node.js).

## Inicio rápido local

```bash
git clone https://github.com/Dortecx/El-Exportador.git
cd el-exportador
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
npm ci
npm run web
```

Se prefiere `npm ci` porque instala las dependencias fijadas en `package-lock.json`. Después de crear `.venv` e instalar los requisitos, `npm run web` usa automáticamente el entorno virtual del proyecto. Definí `M3U_YTMUSIC_PYTHON` solo si necesitás una ruta de intérprete personalizada. Abre `http://localhost:3000` cuando se inicie el servidor.

## Cómo funciona

El Exportador corre como una aplicación web local que te guía desde la carga del archivo hasta la creación de la lista.

```text
Archivo M3U → UI web local → inicio de sesión en navegador → búsqueda con ytmusicapi → revisión de resultados → creación de lista
```

1. La entrada `.m3u` local se analiza para obtener candidatos de artista y título.
2. La UI web local coordina la carga, el progreso, el Modo de prueba, la revisión manual y la creación final.
3. El inicio guiado en tu navegador nativo obtiene los metadatos de sesión de YouTube Music que necesita el backend.
4. El backend Python con `ytmusicapi` busca en YouTube Music y evalúa la confianza de coincidencia para cada candidato.
5. Cada pista se clasifica para que puedas decidir qué hacer después.

| Resultado | Qué significa | Acción del usuario |
|-----------|---------------|--------------------|
| Coincidente | Se encontró una coincidencia confiable en YouTube Music. | Mantenela seleccionada, o deseleccionala antes de crear la lista. |
| No encontrada | No se encontró automáticamente una coincidencia utilizable. | Buscá o elegí un reemplazo manualmente, o dejala afuera. |
| Ambigua | Hay varias coincidencias posibles, o la confianza no alcanza para elegir una sola. | Revisá las opciones y elegí la pista correcta. |

El Modo de prueba hace la búsqueda y clasificación sin crear una lista. Cuando lo desactivás, El Exportador crea la lista de YouTube Music con las selecciones coincidentes, mientras la revisión manual resuelve las pistas pendientes.

Privacidad/localidad: El Exportador analiza el archivo M3U localmente y usa la autenticación/comunicación con la API de YouTube Music solo para buscar y crear listas en tu cuenta.

## Uso

1. Sube un archivo `.m3u` en la aplicación local.

   <img src="docs/images/homepage.png" alt="Pantalla de carga de lista" width="720">

2. Inicia la conversión y consulta su progreso.

   <img src="docs/images/converting_process.png" alt="Pantalla de progreso de conversión" width="720">

3. Resuelve las pistas no encontradas o ambiguas cuando se solicite.

   <img src="docs/images/manual_revision.png" alt="Pantalla de revisión manual de pistas" width="720">

4. Busca la lista creada en YouTube Music.

   <img src="docs/images/Resume.png" alt="Resumen del resultado de la conversión" width="720">

## Aplicación portátil para Windows

Crea el ZIP portátil para Windows desde Windows:

```powershell
npm run build:portable:win
```

Para crear el ZIP portátil se requiere Windows, Node.js 20 o posterior y Python 3.11.8 con PyInstaller. Para ejecutar el ZIP se requiere Node.js 20 o posterior.

YouTube Music usa el inicio de sesión guiado del navegador y su autenticación específica; la privacidad de sus listas sigue el comportamiento de la cuenta/API de YouTube Music.

## Compatibilidad de plataforma

El Exportador es compatible con Windows. El uso nativo en WSL/Linux es experimental y requiere Python 3 más un navegador Linux compatible con Chromium (`google-chrome`, `chromium`, Brave o Microsoft Edge) disponible en el PATH de Linux para el inicio guiado en YouTube Music. La interoperabilidad desde WSL con navegadores `.exe` de Windows no está soportada en esta etapa.

## Licencia

Este proyecto se distribuye bajo la licencia MIT.
