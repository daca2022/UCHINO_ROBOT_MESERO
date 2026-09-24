"""
Order Extractor — Parses orders from LLM text output.

Handles two formats:
1. Natural language: "quiero un lomo saltado y dos inca kola"
2. Function call: registrar_pedido(mesa="M3", platos=[{nombre, cantidad}])
"""

import asyncio
import json
import logging
import re
from difflib import get_close_matches
from typing import Optional

import httpx

from .types import OrderItem, DialogueContext
from .config import BACKEND_URL, MENU_URL, PEDIDOS_URL

logger = logging.getLogger(__name__)


class OrderExtractor:
    """Extracts orders from LLM text and validates against the menu.
    
    Uses fuzzy matching to handle variations in dish names.
    Caches menu for performance.
    """
    
    def __init__(self, backend_url: str = BACKEND_URL):
        self.backend_url = backend_url
        self.menu_cache: list = []
        self.menu_loaded = False
        self._http_client = httpx.AsyncClient(timeout=10.0)
    
    async def load_menu(self) -> list:
        """Fetch menu from backend API and cache it."""
        try:
            response = await self._http_client.get(MENU_URL)
            response.raise_for_status()
            data = response.json()
            self.menu_cache = data.get("data", [])
            self.menu_loaded = True
            logger.info(f"Loaded {len(self.menu_cache)} menu items")
            return self.menu_cache
        except Exception as e:
            logger.warning(f"Failed to load menu: {e}")
            return []
    
    def _find_menu_item(self, name: str) -> Optional[dict]:
        """Find a menu item by name with fuzzy matching.
        
        Tries exact match first, then case-insensitive, then fuzzy.
        """
        if not self.menu_cache:
            return None
        
        # Exact match
        for item in self.menu_cache:
            if item["nombre"].lower() == name.lower():
                return item
        
        # Fuzzy match
        menu_names = [item["nombre"] for item in self.menu_cache]
        matches = get_close_matches(name.lower(), [n.lower() for n in menu_names], n=1, cutoff=0.6)
        if matches:
            for item in self.menu_cache:
                if item["nombre"].lower() == matches[0]:
                    return item
        
        return None
    
    def extract_from_text(self, text: str, mesa: Optional[str] = None) -> dict:
        """Parse natural language text to extract order items.
        
        Examples:
            "quiero un lomo saltado y dos inca kola" → 2 items
            "me da tres ceviches para la mesa 5" → 1 item, mesa M5
            "dos cafés y un arroz con pollo" → 2 items
        """
        items = []
        warnings = []
        
        # Extract mesa number
        mesa_match = re.search(r'mesa\s*(\d+)', text.lower())
        if mesa_match:
            mesa = f"M{mesa_match.group(1)}"
        
        # Pattern: (quantity) (item name)
        # Spanish quantities: un/una = 1, dos = 2, tres = 3, cuatro = 4, cinco = 5
        quantity_words = {
            "un": 1, "una": 1, "uno": 1,
            "dos": 2, "tres": 3, "cuatro": 4, "cinco": 5,
            "seis": 6, "siete": 7, "ocho": 8, "nueve": 9, "diez": 10,
        }
        
        # Build regex pattern for quantities
        qty_pattern = r'(\d+|' + '|'.join(quantity_words.keys()) + r')\s+'
        
        # Find all quantity + item pairs
        pattern = qty_pattern + r'([\w\s]+?)(?:\s+y\s+|\s*,\s*|\s+para\s+|$)'
        matches = re.findall(pattern, text.lower())
        
        if not matches:
            # Try simpler pattern: just item names after "quiero", "me da", "dame"
            simple_pattern = r'(?:quiero|me da|dame|ponme|llévame)\s+(.*?)(?:\s+para\s+|\s+y\s+|$)'
            simple_matches = re.findall(simple_pattern, text.lower())
            for match in simple_matches:
                matches.append(("un", match.strip()))
        
        for qty_str, item_name in matches:
            # Parse quantity
            if qty_str.isdigit():
                cantidad = int(qty_str)
            else:
                cantidad = quantity_words.get(qty_str, 1)
            
            # Clean item name
            item_name = item_name.strip()
            # Remove trailing prepositions
            item_name = re.sub(r'\s+(para|por|de|del|con)$', '', item_name)
            
            # Find in menu
            menu_item = self._find_menu_item(item_name)
            if menu_item:
                items.append(OrderItem(
                    nombre=menu_item["nombre"],
                    cantidad=cantidad,
                    precio=menu_item["precio"],
                    categoria=menu_item.get("categoria", "plato"),
                ))
            else:
                warnings.append(f"No encontré '{item_name}' en el menú")
                items.append(OrderItem(
                    nombre=item_name.title(),
                    cantidad=cantidad,
                    precio=0.0,
                    categoria="plato",
                ))
        
        total = sum(item.precio * item.cantidad for item in items)
        
        return {
            "mesa": mesa or "M1",
            "platos": [item.to_dict() for item in items],
            "total": total,
            "modo": "voz",
            "warnings": warnings,
        }
    
    def extract_function_call(self, function_call: dict) -> dict:
        """Parse registrar_pedido function call into order format.
        
        Expected format:
        {
            "name": "registrar_pedido",
            "arguments": {
                "mesa": "M3",
                "platos": [{"nombre": "Ceviche", "cantidad": 2}],
                "total": 44
            }
        }
        """
        args = function_call.get("arguments", {})
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                return {"mesa": "M1", "platos": [], "total": 0, "modo": "voz", "warnings": ["Invalid function call arguments"]}
        
        mesa = args.get("mesa", "M1")
        platos_raw = args.get("platos", [])
        total_from_call = args.get("total", 0)
        
        items = []
        warnings = []
        
        for plato in platos_raw:
            nombre = plato.get("nombre", "")
            cantidad = plato.get("cantidad", 1)
            
            menu_item = self._find_menu_item(nombre)
            if menu_item:
                items.append(OrderItem(
                    nombre=menu_item["nombre"],
                    cantidad=cantidad,
                    precio=menu_item["precio"],
                    categoria=menu_item.get("categoria", "plato"),
                ))
            else:
                warnings.append(f"No encontré '{nombre}' en el menú")
                items.append(OrderItem(
                    nombre=nombre,
                    cantidad=cantidad,
                    precio=plato.get("precio", 0.0),
                    categoria=plato.get("categoria", "plato"),
                ))
        
        total = total_from_call or sum(item.precio * item.cantidad for item in items)
        
        return {
            "mesa": mesa,
            "platos": [item.to_dict() for item in items],
            "total": total,
            "modo": "voz",
            "warnings": warnings,
        }
    
    async def send_order(self, order: dict) -> dict:
        """Send order to backend via POST /api/pedidos.
        
        Removes 'warnings' key before sending (not part of API).
        """
        # Clean order for API
        clean_order = {k: v for k, v in order.items() if k != "warnings"}
        
        try:
            response = await self._http_client.post(
                PEDIDOS_URL,
                json=clean_order,
                timeout=10.0,
            )
            response.raise_for_status()
            result = response.json()
            logger.info(f"Order sent: mesa={clean_order.get('mesa')}, items={len(clean_order.get('platos', []))}")
            return result
        except Exception as e:
            logger.error(f"Failed to send order: {e}")
            return {"error": str(e)}
    
    async def close(self):
        """Close HTTP client."""
        await self._http_client.aclose()
