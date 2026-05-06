# OAuth para YouTube Music
cd "C:/Users/Dom/Documents/Projects/El Exportador/m3u-to-ytmusic"
.venv\Scripts\python.exe -c "
from ytmusicapi.auth.oauth import OAuthCredentials, RefreshingToken
import os
os.makedirs('C:/Users/Dom/.config/m3u-to-ytmusic', exist_ok=True)
creds = OAuthCredentials()
token = RefreshingToken.prompt_for_token(creds, open_browser=True, to_file='C:/Users/Dom/.config/m3u-to-ytmusic/ytmusic_auth.json')
print('Auth guardado!')
"