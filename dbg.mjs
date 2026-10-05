import multer from "multer"; import express from "express";
const app=express(); const up=multer({storage:multer.memoryStorage()});
app.post("/x", up.array("fotos",5),(req,res)=>res.json({body:req.body,n:req.files.length}));
app.listen(3101);
