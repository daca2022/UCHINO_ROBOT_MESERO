class HandlerRouter:
    def __init__(self, handler):
        self.handler = handler

    async def route(self, function_call: dict) -> dict:
        fn_name = function_call.get("name", "")
        fn_args = function_call.get("args", {})
        handler_fn = self.handler.get_handler(fn_name)
        if not handler_fn:
            return {"success": False, "error": f"Función desconocida: {fn_name}"}
        try:
            return await handler_fn(fn_args)
        except Exception as e:
            return {"success": False, "error": str(e)}
