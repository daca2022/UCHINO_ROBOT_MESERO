import uuid
from datetime import datetime, timezone


class FunctionCallHandler:
    def __init__(self, db_session=None, chroma_client=None):
        self.db = db_session
        self.chroma = chroma_client
        self._pedidos = {}
        self._last_pedido_id = None
        self._memory_store = []

    async def registrar_pedido(self, params: dict) -> dict:
        platos = params.get("platos")
        if not platos:
            return {"success": False, "error": "platos es requerido y no puede estar vacío"}
        if not isinstance(platos, list) or len(platos) == 0:
            return {"success": False, "error": "platos debe ser una lista no vacía"}

        pedido_id = str(uuid.uuid4())
        pedido = {
            "id": pedido_id,
            "mesa": params.get("mesa", ""),
            "platos": platos,
            "bebida": params.get("bebida", ""),
            "total": params.get("total", 0.0),
            "estado": "provisional",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        if self.db is not None:
            try:
                await self._insert_pedido_db(pedido)
            except Exception:
                pass

        self._pedidos[pedido_id] = pedido
        self._last_pedido_id = pedido_id

        return {
            "success": True,
            "pedido_id": pedido_id,
            "message": "Pedido registrado",
        }

    async def confirmar_pedido(self, params: dict) -> dict:
        pedido_id = self._last_pedido_id
        if not pedido_id:
            return {"success": False, "error": "No hay pedido activo para confirmar"}

        if pedido_id in self._pedidos:
            self._pedidos[pedido_id]["estado"] = "confirmado"

        if self.db is not None:
            try:
                await self._update_pedido_db(pedido_id, {"estado": "confirmado"})
            except Exception:
                pass

        return {"success": True, "message": "Pedido confirmado"}

    async def cancelar_pedido(self, params: dict) -> dict:
        pedido_id = self._last_pedido_id
        if not pedido_id:
            return {"success": False, "error": "No hay pedido activo para cancelar"}

        if pedido_id in self._pedidos:
            self._pedidos[pedido_id]["estado"] = "cancelado"

        if self.db is not None:
            try:
                await self._update_pedido_db(pedido_id, {"estado": "cancelado"})
            except Exception:
                pass

        return {"success": True, "message": "Pedido cancelado"}

    async def ir_a_lugar(self, params: dict) -> dict:
        valid_lugares = ["MESA", "COCINA", "UTENSILIOS", "BEBIDAS", "CAJA", "BASE"]
        lugar = params.get("lugar", "")
        if lugar not in valid_lugares:
            return {"success": False, "error": f"Lugar inválido: {lugar}"}

        print(f"[FunctionCall] ir_a_lugar: {lugar}")
        return {
            "success": True,
            "lugar": lugar,
            "message": f"Robot dirigiéndose a {lugar}",
        }

    async def expresar_emocion(self, params: dict) -> dict:
        valid = ["feliz", "emocionado", "pensando", "sorprendido", "guiño", "triste", "celebrando"]
        emocion = params.get("emocion", "pensando")
        if emocion not in valid:
            return {"success": False, "error": f"Emoción inválida: {emocion}"}
        mensaje = params.get("mensaje", "")
        return {"success": True, "emocion": emocion, "mensaje": mensaje}

    async def mostrar_menu(self, params: dict) -> dict:
        etapa = params.get("etapa", "completo")
        return {"success": True, "etapa": etapa, "action": "mostrar_menu"}

    async def guardar_memoria(self, params: dict) -> dict:
        categoria = params.get("categoria", "hecho")
        clave = params.get("clave", "")
        valor = params.get("valor", "")
        if not clave or not valor:
            return {"success": False, "error": "clave y valor son requeridos"}

        entry = {
            "categoria": categoria,
            "clave": clave,
            "valor": valor,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        if self.chroma is not None:
            try:
                await self._insert_chroma(entry)
            except Exception:
                pass

        if self.db is not None:
            try:
                await self._insert_memory_db(entry)
            except Exception:
                pass

        self._memory_store.append(entry)
        return {"success": True, "categoria": categoria, "clave": clave}

    def get_handler(self, function_name: str):
        handlers = {
            "registrar_pedido": self.registrar_pedido,
            "confirmar_pedido": self.confirmar_pedido,
            "cancelar_pedido": self.cancelar_pedido,
            "ir_a_lugar": self.ir_a_lugar,
            "expresar_emocion": self.expresar_emocion,
            "mostrar_menu": self.mostrar_menu,
            "guardar_memoria": self.guardar_memoria,
        }
        return handlers.get(function_name)

    async def _insert_pedido_db(self, pedido: dict):
        pass

    async def _update_pedido_db(self, pedido_id: str, updates: dict):
        pass

    async def _insert_chroma(self, entry: dict):
        pass

    async def _insert_memory_db(self, entry: dict):
        pass
