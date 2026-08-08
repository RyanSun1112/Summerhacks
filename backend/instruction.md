# Running Backend + ngrok
 
## 1. Run the backend
 
```bash
cd pulse-backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python app.py
```
 
Server runs at `http://localhost:5000`.
 
## 2. Expose it over HTTPS with ngrok
 
Motion, orientation, and GPS APIs only work on HTTPS (or `localhost`), so you need ngrok to test on a phone.
 
```bash
ngrok http 5000
```
 
Copy the `https://...ngrok-free.app` URL it prints.

