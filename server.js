const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const crypto = require('crypto');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// 配置（新表格）
// ============================================================
const CONFIG = {
    APP_ID: process.env.FEISHU_APP_ID || 'cli_a941923f1a611ceb',
    APP_SECRET: process.env.FEISHU_APP_SECRET || 'pu4EkjA8mEDKiuoQyBnHLwk8wYYzKUXs',
    // 图片库（新表格）
    BITABLE_IMAGES_TOKEN: process.env.BITABLE_IMAGES_TOKEN || 'XNAXbj5kDax01yseSaSczaQVnmd',
    TABLE_IMAGES: process.env.TABLE_IMAGES || 'tblUHoJzQqCX7C7c',
    // 下载记录（新表格）
    BITABLE_RECORDS_TOKEN: process.env.BITABLE_RECORDS_TOKEN || 'JaC1b0c7UaBFr1sQvnCcEAUxnph',
    TABLE_RECORDS: process.env.TABLE_RECORDS || 'tblIIIZTH7SS1C2O',
    ADMIN_PASSWORD_HASH: crypto.createHash('sha256').update('a3481616244.').digest('hex'),
};

// ============================================================
// Token 缓存
// ============================================================
let tokenCache = { token: null, expiresAt: 0 };

async function getTenantToken() {
    if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) {
        return tokenCache.token;
    }
    const res = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: CONFIG.APP_ID,
        app_secret: CONFIG.APP_SECRET
    });
    tokenCache.token = res.data.tenant_access_token;
    tokenCache.expiresAt = Date.now() + res.data.expire * 1000;
    return tokenCache.token;
}

// ============================================================
// 管理员验证
// ============================================================
app.post('/api/admin-login', (req, res) => {
    const { password } = req.body;
    const hash = crypto.createHash('sha256').update(password || '').digest('hex');
    if (hash === CONFIG.ADMIN_PASSWORD_HASH) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: '密码错误' });
    }
});

// ============================================================
// 图片列表（字段名：图片名称、图片URL、颜色、主题、下载次数）
// ============================================================
app.get('/api/images', async (req, res) => {
    try {
        const token = await getTenantToken();
        let allItems = [];
        let pageToken = '';

        do {
            const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records?page_size=100${pageToken ? '&page_token=' + pageToken : ''}`;
            const response = await axios.get(url, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = response.data.data;
            allItems = allItems.concat(data.items || []);
            pageToken = data.has_more ? data.page_token : '';
        } while (pageToken);

        const images = allItems.map(item => {
            const f = item.fields;
            // 处理图片URL：优先用「图片URL」文本字段，其次用附件
            let imageUrl = '';
            if (f['图片URL'] && typeof f['图片URL'] === 'string') {
                imageUrl = f['图片URL'];
            } else if (Array.isArray(f['图片URL']) && f['图片URL'].length > 0) {
                imageUrl = f['图片URL'][0].url || f['图片URL'][0].tmp_url || '';
            } else if (f['图片'] && Array.isArray(f['图片']) && f['图片'].length > 0) {
                imageUrl = f['图片'][0].url || f['图片'][0].tmp_url || '';
            }

            // 处理下载次数（可能是数字或文本）
            const downloads = parseInt(f['下载次数'] || 0) || 0;

            // 处理已下载国家（逗号分隔文本）
            let countries = [];
            if (f['已下载国家']) {
                countries = String(f['已下载国家']).split(',').map(s => s.trim()).filter(Boolean);
            }

            return {
                id: item.record_id,
                name: f['图片名称'] || '',
                url: imageUrl,
                color: f['颜色'] || '',
                theme: f['主题'] || '',
                downloads,
                countries
            };
        }).filter(img => img.name); // 过滤空记录

        res.json({ success: true, data: images });
    } catch (err) {
        console.error('获取图片失败:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 下载记录列表
// ============================================================
app.get('/api/records', async (req, res) => {
    try {
        const token = await getTenantToken();
        let allItems = [];
        let pageToken = '';

        do {
            const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_RECORDS_TOKEN}/tables/${CONFIG.TABLE_RECORDS}/records?page_size=100${pageToken ? '&page_token=' + pageToken : ''}`;
            const response = await axios.get(url, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = response.data.data;
            allItems = allItems.concat(data.items || []);
            pageToken = data.has_more ? data.page_token : '';
        } while (pageToken);

        const records = allItems.map(item => {
            const f = item.fields;
            return {
                id: item.record_id,
                imageName: f['图片名称'] || '',
                name: f['下载人'] || '',
                date: f['上线时间'] || '',
                country: f['所属国家'] || '',
                downloadTime: f['下载时间'] || ''
            };
        }).filter(r => r.name).reverse();

        res.json({ success: true, data: records });
    } catch (err) {
        console.error('获取记录失败:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 提交下载记录
// ============================================================
app.post('/api/download', async (req, res) => {
    try {
        const token = await getTenantToken();
        const { imageId, imageName, name, date, country } = req.body;

        if (!name || !date || !country || !imageId) {
            return res.status(400).json({ success: false, error: '缺少必填字段' });
        }

        const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

        // 写入下载记录
        await axios.post(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_RECORDS_TOKEN}/tables/${CONFIG.TABLE_RECORDS}/records`,
            {
                fields: {
                    '图片名称': imageName,
                    '下载人': name,
                    '上线时间': date,
                    '所属国家': country,
                    '下载时间': now
                }
            },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );

        // 更新图片下载次数和已下载国家
        try {
            const imgRes = await axios.get(
                `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records/${imageId}`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            const fields = imgRes.data.data.record.fields;
            const currentDownloads = parseInt(fields['下载次数'] || 0) || 0;
            const currentCountries = fields['已下载国家']
                ? String(fields['已下载国家']).split(',').map(s => s.trim()).filter(Boolean)
                : [];
            if (!currentCountries.includes(country)) currentCountries.push(country);

            await axios.put(
                `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records/${imageId}`,
                {
                    fields: {
                        '下载次数': String(currentDownloads + 1),
                        '已下载国家': currentCountries.join(',')
                    }
                },
                { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
            );
        } catch (e) {
            console.warn('更新下载次数失败（非致命）:', e.message);
        }

        res.json({ success: true });
    } catch (err) {
        console.error('下载记录失败:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 上传图片（存图片URL到表格）
// ============================================================
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        const token = await getTenantToken();
        const file = req.file;
        const imageName = req.body.name || (file ? file.originalname.replace(/\.[^/.]+$/, '') : '未命名');
        const color = req.body.color || '';
        const theme = req.body.theme || '';
        const imageUrl = req.body.imageUrl || '';

        // 如果直接提供了URL（无文件上传）
        if (!file && imageUrl) {
            await axios.post(
                `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records`,
                {
                    fields: {
                        '图片名称': imageName,
                        '图片URL': imageUrl,
                        '颜色': color,
                        '主题': theme,
                        '下载次数': '0'
                    }
                },
                { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
            );
            return res.json({ success: true });
        }

        if (!file) return res.status(400).json({ success: false, error: '没有文件' });

        // 上传文件到飞书云盘
        const formData = new FormData();
        formData.append('file_name', file.originalname);
        formData.append('parent_type', 'bitable_file');
        formData.append('parent_node', CONFIG.BITABLE_IMAGES_TOKEN);
        formData.append('size', file.size.toString());
        formData.append('file', file.buffer, {
            filename: file.originalname,
            contentType: file.mimetype
        });

        const uploadRes = await axios.post(
            'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
            formData,
            { headers: { Authorization: `Bearer ${token}`, ...formData.getHeaders() } }
        );

        const fileToken = uploadRes.data.data?.file_token;
        if (!fileToken) throw new Error('上传失败，未获取到 file_token');

        // 获取文件临时下载链接
        const dlRes = await axios.get(
            `https://open.feishu.cn/open-apis/drive/v1/medias/${fileToken}/download`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        const tmpUrl = dlRes.data.data?.tmp_download_url || '';

        // 写入多维表格
        await axios.post(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records`,
            {
                fields: {
                    '图片名称': imageName,
                    '图片URL': tmpUrl,
                    '颜色': color,
                    '主题': theme,
                    '下载次数': '0'
                }
            },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );

        res.json({ success: true });
    } catch (err) {
        console.error('上传失败:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 更新图片分类
// ============================================================
app.put('/api/images/:id', async (req, res) => {
    try {
        const token = await getTenantToken();
        const { id } = req.params;
        const { name, color, theme } = req.body;

        await axios.put(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records/${id}`,
            { fields: { '图片名称': name, '颜色': color, '主题': theme } },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );

        res.json({ success: true });
    } catch (err) {
        console.error('更新失败:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 健康检查
// ============================================================
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ 飞书图片资源中心已启动: http://localhost:${PORT}`);
});
