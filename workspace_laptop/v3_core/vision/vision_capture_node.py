#!/usr/bin/env python3
"""
vision_capture_node.py — ROS2 Vision Capture Node for RGB USB camera.

Runs on RPi5. Subscribes to the RGB camera topic, provides:
  - ROS2 Service: /capture_frame  → returns base64 JPEG (768x768)
  - HTTP Bridge:   http://0.0.0.0:8765/capture → returns JSON { success, image_base64, ... }

Architecture: Single-frame on demand — no continuous streaming.
"""

import base64
import io
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, HistoryPolicy
from sensor_msgs.msg import Image as RosImage
from cv_bridge import CvBridge
import cv2

# Try importing custom service; fall back if not built
try:
    from robot_mesero_interfaces.srv import CaptureFrame
    HAS_CUSTOM_SRV = True
except ImportError:
    HAS_CUSTOM_SRV = False

# ── Configuration ──────────────────────────────────────────────────────────────
CAPTURE_WIDTH   = 768
CAPTURE_HEIGHT  = 768
JPEG_QUALITY    = 85          # 0-100; 85 balances quality/size ~50-120KB
HTTP_PORT       = 8765
CAMERA_TOPIC    = os.getenv("VISION_CAMERA_TOPIC", "/camera/image_raw")


class VisionCaptureNode(Node):
    """ROS2 node that caches the latest frame and serves capture requests."""

    def __init__(self):
        super().__init__('vision_capture_node')

        # QoS: Best effort, keep last 1 — we only want the latest frame
        sensor_qos = QoSProfile(
            reliability=ReliabilityPolicy.BEST_EFFORT,
            history=HistoryPolicy.KEEP_LAST,
            depth=1
        )

        self.bridge = CvBridge()
        self._lock = threading.Lock()
        self._latest_frame = None    # numpy array (H, W, 3) BGR8
        self._frame_timestamp = 0.0
        self._frame_count = 0

        self.subscription = self.create_subscription(
            RosImage,
            CAMERA_TOPIC,
            self._image_callback,
            sensor_qos
        )

        # ROS2 Capture Service
        if HAS_CUSTOM_SRV:
            self.capture_srv = self.create_service(
                CaptureFrame,
                'capture_frame',
                self._capture_callback
            )
            self.get_logger().info('CaptureFrame service ready: /capture_frame')

        self.get_logger().info(f'VisionCaptureNode started. Subscribing to {CAMERA_TOPIC}')
        self.get_logger().info(f'Output: {CAPTURE_WIDTH}x{CAPTURE_HEIGHT} JPEG (q={JPEG_QUALITY})')

    # ── Image Callback ──────────────────────────────────────────────────────

    def _image_callback(self, msg: RosImage):
        """Cache the latest frame. Called by ROS2 executor thread."""
        try:
            # Convert ROS Image → OpenCV BGR numpy array
            cv_image = self.bridge.imgmsg_to_cv2(msg, desired_encoding='bgr8')
            with self._lock:
                self._latest_frame = cv_image
                self._frame_timestamp = time.time()
                self._frame_count += 1
        except Exception as e:
            self.get_logger().error(f'Frame conversion error: {e}')

    # ── Frame Capture Logic ─────────────────────────────────────────────────

    def capture_jpeg_base64(self) -> dict:
        """Capture latest frame, resize to 768x768, encode as JPEG base64.

        Returns:
            dict with: success, image_base64, width, height, timestamp, frame_number
        """
        with self._lock:
            frame = self._latest_frame
            ts = self._frame_timestamp
            fnum = self._frame_count

        if frame is None:
            return {
                'success': False,
                'error': 'No frame available yet. Camera may not be publishing.',
                'image_base64': None,
                'width': 0,
                'height': 0,
                'timestamp': time.time(),
                'frame_number': 0
            }

        try:
            # Resize to 768x768 (OpenRouter vision limit)
            h, w = frame.shape[:2]
            if w != CAPTURE_WIDTH or h != CAPTURE_HEIGHT:
                resized = cv2.resize(frame, (CAPTURE_WIDTH, CAPTURE_HEIGHT),
                                     interpolation=cv2.INTER_AREA)
            else:
                resized = frame

            # Encode as JPEG
            _, jpeg_bytes = cv2.imencode('.jpg', resized,
                                         [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            b64 = base64.b64encode(jpeg_bytes).decode('ascii')

            self.get_logger().info(
                f'Frame captured: {CAPTURE_WIDTH}x{CAPTURE_HEIGHT}, '
                f'{len(jpeg_bytes)} bytes JPEG, '
                f'#{fnum} @ t={ts:.3f}'
            )

            return {
                'success': True,
                'image_base64': b64,
                'width': CAPTURE_WIDTH,
                'height': CAPTURE_HEIGHT,
                'size_bytes': len(jpeg_bytes),
                'timestamp': ts,
                'frame_number': fnum
            }
        except Exception as e:
            self.get_logger().error(f'JPEG encode error: {e}')
            return {
                'success': False,
                'error': str(e),
                'image_base64': None,
                'width': 0,
                'height': 0,
                'timestamp': time.time(),
                'frame_number': fnum
            }

    # ── ROS2 Service Handler ────────────────────────────────────────────────

    def _capture_callback(self, request, response):
        result = self.capture_jpeg_base64()
        if HAS_CUSTOM_SRV:
            response.success = result['success']
            response.image_base64 = result['image_base64'] or ''
            response.width = result['width']
            response.height = result['height']
            response.error = result.get('error', '')
        return response


# ── HTTP Bridge ──────────────────────────────────────────────────────────────

class CaptureHTTPHandler(BaseHTTPRequestHandler):
    """Simple HTTP handler that returns the latest frame as JSON."""

    # Class-level reference to the ROS2 node (set by main)
    ros_node: VisionCaptureNode = None

    def do_GET(self):
        if self.path == '/capture':
            result = CaptureHTTPHandler.ros_node.capture_jpeg_base64()
            self.send_response(200 if result['success'] else 503)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(json.dumps(result).encode('utf-8'))
        elif self.path == '/health':
            result = CaptureHTTPHandler.ros_node.capture_jpeg_base64()
            status = 'ok' if result['success'] else 'no_frame'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({
                'status': status,
                'frame_number': result['frame_number'],
                'timestamp': result['timestamp']
            }).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        """Suppress HTTP server logging noise."""
        pass


def run_http_bridge(ros_node: VisionCaptureNode):
    """Run a tiny HTTP server in a background thread."""
    CaptureHTTPHandler.ros_node = ros_node
    server = HTTPServer(('0.0.0.0', HTTP_PORT), CaptureHTTPHandler)
    ros_node.get_logger().info(f'HTTP bridge listening on http://0.0.0.0:{HTTP_PORT}/capture')
    server.serve_forever()


# ── Main ─────────────────────────────────────────────────────────────────────

def main(args=None):
    rclpy.init(args=args)
    node = VisionCaptureNode()

    # Start HTTP bridge in a daemon thread
    http_thread = threading.Thread(
        target=run_http_bridge,
        args=(node,),
        daemon=True,
        name='http-bridge'
    )
    http_thread.start()

    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        node.get_logger().info('Shutting down...')
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
